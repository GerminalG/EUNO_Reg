import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  // 1) Fetch pending docs
  const { data: docs, error } = await sb
    .from("reg_documents")
    .select("*")
    .eq("status", "pending")
    .limit(20);

  if (error) throw error;
  if (!docs || docs.length === 0) {
    console.log("No pending documents.");
    return;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const doc of docs) {
    console.log("Processing:", doc.canonical_url);

    try {
      await page.goto(doc.canonical_url, { waitUntil: "networkidle", timeout: 60000 });

      // Extract visible text (simple MVP)
      const text = await page.evaluate(() => document.body?.innerText || "");
      const hash = sha256(text);

      // Determine next version
      let nextVersion = doc.latest_version || 1;
      let changed = doc.content_hash ? doc.content_hash !== hash : true;

      if (!doc.content_hash) changed = true;

      if (doc.content_hash && !changed) {
        // No change → just mark checked
        await sb.from("reg_documents").update({
          status: "active",
          last_checked_at: new Date().toISOString()
        }).eq("id", doc.id);

        console.log("No change, updated last_checked_at.");
        continue;
      }

      // If changed and already had a version, increment
      if (doc.content_hash) nextVersion = (doc.latest_version || 1) + 1;

      // Create PDF snapshot
      const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });

      // Upload PDF to Storage
      const path = `${doc.id}/v${nextVersion}/snapshot.pdf`;
      const { error: upErr } = await sb.storage
        .from("regulations")
        .upload(path, pdfBuffer, { contentType: "application/pdf", upsert: true });
      if (upErr) throw upErr;

      // Update main doc row
      const title = await page.title();

      await sb.from("reg_documents").update({
        title,
        status: "active",
        latest_version: nextVersion,
        snapshot_path: path,
        full_text: text,
        content_hash: hash,
        retrieved_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", doc.id);

      // Insert version row
      await sb.from("reg_document_versions").insert({
        reg_document_id: doc.id,
        version: nextVersion,
        snapshot_path: path,
        full_text: text,
        content_hash: hash,
        retrieved_at: new Date().toISOString()
      });

      console.log("Saved version", nextVersion);
    } catch (e) {
      console.error("Failed:", doc.canonical_url, e.message);

      await sb.from("reg_documents").update({
        status: "error",
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", doc.id);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
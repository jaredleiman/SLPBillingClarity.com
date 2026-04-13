// ═══════════════════════════════════════════════════════════════════════════════
// SLPBillingClarity.com — Cloudflare Worker
// Tally webhook → Claude API (Haiku) → Resend email → Google Sheets logging
// Monthly cron trigger: 0 9 1 * *
// ═══════════════════════════════════════════════════════════════════════════════

const SITE_URL = "https://slpbillingclarity.com";
const SITE_NAME = "SLPBillingClarity";
const FROM_EMAIL = "SLPBillingClarity <reports@slpbillingclarity.com>";
const CONTACT_EMAIL = "hello@slpbillingclarity.com";

// ⚠️ REPLACE THIS with your actual Stripe Customer Portal link
const STRIPE_PORTAL_URL = "STRIPE_PORTAL_LINK_HERE";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      // Return 200 immediately, process in background
      ctx.waitUntil(handleSubmission(body, env));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonthlyDigest(env));
  },
};

// ─── HANDLE TALLY SUBMISSION ─────────────────────────────────────────────────

async function handleSubmission(body, env) {
  const fields = body?.data?.fields || [];

  const getValue = (label) => {
    const field = fields.find((f) => f.label === label);
    return field?.value || "";
  };

  const getCheckboxes = (label) => {
    const field = fields.find((f) => f.label === label);
    if (!field) return "";
    if (Array.isArray(field.value)) {
      return field.value.map((v) => (typeof v === "object" ? v.name || v.value || v : v)).join(", ");
    }
    if (Array.isArray(field.options)) {
      return field.options.filter((o) => o.id && field.value?.includes?.(o.id)).map((o) => o.name || o.text).join(", ");
    }
    return String(field.value || "");
  };

  const firstName = getValue("First Name");
  const lastName = getValue("Last Name");
  const toName = `${firstName} ${lastName}`.trim();
  const toEmail = getValue("Email");
  const practiceName = getValue("Practice Name");
  const state = getValue("State");
  const carriers = getCheckboxes("Payers / Carriers");
  const otherCarriers = getValue("If \"Other\" — please list your additional payers");

  const allCarriers = otherCarriers ? `${carriers}, ${otherCarriers}` : carriers;

  if (!toEmail) {
    console.error("No email found in submission");
    return;
  }

  // Generate report
  const reportHtml = await generateReport({ toName, practiceName, state, carriers: allCarriers }, env);

  // Send email
  await sendEmail({ toName, toEmail, practiceName, reportHtml }, env);

  // Log to sheet
  await logToSheet({ toName, toEmail, practiceName, state, carriers: allCarriers }, env);

  console.log("Report sent to:", toEmail);
}

// ─── GENERATE REPORT VIA CLAUDE ──────────────────────────────────────────────

async function generateReport({ toName, practiceName, state, carriers }, env) {
  const systemPrompt = `You are a Medicare billing compliance intelligence analyst specializing in speech-language pathology (SLP) services. You produce monthly compliance briefings for independent SLP practices.

CRITICAL COMPLIANCE FRAMING RULES — follow these exactly:
- You provide GENERAL COMPLIANCE INTELLIGENCE FOR EDUCATIONAL PURPOSES ONLY
- You are NOT providing legal advice, billing advice, or compliance consulting
- NEVER use language like "you are legally required to," "this violates," "you must," or "failure to comply will result in"
- ALWAYS frame findings as: "OIG has flagged," "CMS guidance indicates," "best practice suggests," "MAC audit data shows," "current enforcement priorities include"
- End every report with this exact disclaimer: "This report is general compliance intelligence for educational purposes only. It is not legal advice, not billing advice, and not a substitute for a qualified healthcare attorney or certified professional coder."

REPORT STRUCTURE — use these exact section headings with ## markdown:
## CPT Code Updates
Focus on 92507, 92508, 92521–92524, 96105, 96125, 92610, 92611. Cover reimbursement changes, documentation updates, and code-specific audit signals.

## Modifier Compliance
Cover -GN modifier (SLP services), KX modifier (medical necessity certification), NCCI edit pairs affecting SLP codes, and modifier stacking rules.

## OIG & MAC Enforcement Signals
Current audit priorities for SLP services — evaluation code upcoding, missing KX documentation, telehealth documentation gaps, the mid-2025 "qualified SLP" ruling impact.

## Telehealth Billing Rules
Post-2025 telehealth coverage for SLP services — place of service codes, modifier 95/GT, state-specific Medicaid telehealth rules, documentation requirements.

## Therapy Cap & Exceptions
Current therapy cap thresholds, automatic exception processes, KX modifier documentation requirements at cap, targeted medical review triggers.

## Carrier-Specific Updates
Payer-by-payer changes relevant to this practice's carrier mix. Cover prior auth changes, fee schedule updates, denial trends, and coverage policy shifts.

FORMATTING RULES:
- Use ## for section headings
- Use **bold** for key terms and CPT codes
- Use bullet points for lists
- Use --- between sections
- Keep language clear, direct, and specific
- Include specific CPT codes, modifier codes, and regulatory citations where relevant
- Reference the practice's state and carriers throughout`;

  const userPrompt = `Generate the monthly Medicare billing compliance intelligence report for:

Practice: ${practiceName || toName}
State: ${state || "Not specified"}
Payers/Carriers: ${carriers || "Not specified"}
Report Month: ${new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}

Provide a comprehensive, practice-specific compliance briefing covering all six sections. Reference their state and carriers throughout. Include specific CPT codes, modifier requirements, and regulatory citations.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const markdown = data?.content?.[0]?.text || "Report generation failed.";
  return markdownToHtml(markdown);
}

// ─── MARKDOWN TO HTML ────────────────────────────────────────────────────────

function markdownToHtml(md) {
  return md
    .replace(/^## (.+)$/gm, '<h2 style="margin:32px 0 16px;font-size:20px;font-weight:700;color:#1B3A6B;border-bottom:2px solid #E8A020;padding-bottom:8px;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="margin:20px 0 10px;font-size:16px;font-weight:700;color:#1B3A6B;">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #DDD8CE;margin:28px 0;"/>')
    .replace(/^- (.+)$/gm, '<li style="margin-bottom:6px;">$1</li>')
    .replace(/(<li[^>]*>.*<\/li>\n?)+/gs, '<ul style="padding-left:20px;margin:12px 0;">$&</ul>')
    .replace(/\n\n/g, '</p><p style="margin-bottom:14px;line-height:1.65;">')
    .replace(/^(?!<[hulh])(.+)$/gm, '<p style="margin-bottom:14px;line-height:1.65;">$1</p>')
    .replace(/<p[^>]*><\/p>/g, "");
}

// ─── EMAIL VIA RESEND ────────────────────────────────────────────────────────

async function sendEmail({ toName, toEmail, practiceName, reportHtml }, env) {
  const firstName = toName.split(" ")[0] || toName;
  const subject = `Your SLP Medicare Billing Compliance Report — ${new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}`;

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#F5F5F0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F0;padding:32px 16px;">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- HEADER -->
        <tr><td style="background:#1B3A6B;padding:32px 40px;">
          <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#E8A020;">SLPBillingClarity.com</p>
          <h1 style="margin:10px 0 4px;font-size:24px;font-weight:700;color:#FFFFFF;line-height:1.2;">Medicare Billing Compliance Report</h1>
          <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.65);">${new Date().toLocaleString("en-US", { month: "long", year: "numeric" })} · ${practiceName || toName}</p>
        </td></tr>

        <!-- BODY -->
        <tr><td style="padding:40px;color:#1A1A2E;font-size:15px;line-height:1.65;">
          <p style="margin:0 0 20px;">Hi ${firstName},</p>
          <p style="margin:0 0 28px;color:#4A4A65;">Your monthly Medicare billing compliance intelligence report is ready. This report reflects current CMS policies, OIG enforcement priorities, and carrier-specific updates relevant to your SLP practice.</p>
          ${reportHtml}
          <div style="margin-top:36px;padding:20px 24px;background:#FFF8E1;border-left:4px solid #E8A020;border-radius:6px;">
            <p style="margin:0;font-size:13px;color:#6B4A00;line-height:1.6;"><strong>Disclaimer:</strong> This report is general compliance intelligence for educational purposes only. It is not legal advice, not billing advice, and not a substitute for a qualified healthcare attorney or certified professional coder.</p>
          </div>
        </td></tr>

        <!-- FOOTER -->
        <tr><td style="background:#F0EDE6;padding:24px 40px;border-top:1px solid #DDD8CE;">
          <p style="margin:0;font-size:12px;color:#7A7A95;line-height:1.7;">
            © 2026 SLPBillingClarity.com · A Digital Services USA property<br/>
            Questions? Reply to this email or contact <a href="mailto:${CONTACT_EMAIL}" style="color:#1B3A6B;">${CONTACT_EMAIL}</a><br/>
            To manage or cancel your subscription, <a href="${STRIPE_PORTAL_URL}" style="color:#1B3A6B;">click here to access your billing portal</a>.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [toEmail],
      subject,
      html: htmlBody,
    }),
  });

  if (!resendResponse.ok) {
    const err = await resendResponse.text();
    throw new Error(`Resend error: ${resendResponse.status} — ${err}`);
  }

  return true;
}

// ─── GOOGLE SHEETS LOGGING ───────────────────────────────────────────────────

async function logToSheet({ toName, toEmail, practiceName, state, carriers }, env) {
  if (!env.SHEET_ID) return;

  // Log to console for Cloudflare visibility
  console.log("New subscriber:", {
    toName,
    toEmail,
    practiceName,
    state,
    carriers,
    date: new Date().toISOString(),
  });
}

// ─── MONTHLY DIGEST CRON ─────────────────────────────────────────────────────

async function runMonthlyDigest(env) {
  if (!env.SHEET_ID) {
    console.log("SHEET_ID not set — skipping monthly digest");
    return;
  }

  // Read subscribers from Google Sheets (must be published as public CSV)
  const csvUrl = `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/export?format=csv&gid=0`;
  const sheetResponse = await fetch(csvUrl);
  if (!sheetResponse.ok) {
    console.error("Failed to fetch subscriber sheet");
    return;
  }

  const csv = await sheetResponse.text();
  const rows = csv.trim().split("\n").slice(1); // skip header

  for (const row of rows) {
    const cols = row.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const [name, email, practiceName, state, carriers, , , status] = cols;

    if (!email || status?.toLowerCase() !== "active") continue;

    try {
      const reportHtml = await generateReport({ toName: name, practiceName, state, carriers }, env);
      await sendEmail({ toName: name, toEmail: email, practiceName, reportHtml }, env);
      console.log("Digest sent to:", email);
    } catch (err) {
      console.error("Digest error for", email, err);
    }
  }
}

/**
 * IT Study Hub: mail relay (Google Apps Script)
 * Sends the 6-digit sign-in code from YOUR Gmail account. Free, no domain needed.
 * Setup: script.google.com > New project > paste this file > set SECRET below > Deploy > New deployment >
 * type "Web app", Execute as "Me", Who has access "Anyone" > copy the web app URL.
 * Then add two secrets to your Cloudflare Worker: MAIL_RELAY_URL (that URL) and MAIL_RELAY_SECRET (SECRET below).
 * Gmail allows about 100 recipients a day for free accounts, which is plenty for sign-in codes.
 */
const SECRET = 'PASTE-A-LONG-RANDOM-STRING-HERE';   // must be identical to MAIL_RELAY_SECRET on the Worker

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return reply({ ok: false, error: 'forbidden' });
    if (!/^[^\s@<>"'`\\]{1,64}@[^\s@<>"'`\\]{1,255}\.[^\s@<>"'`\\]{2,}$/.test(String(d.to))) return reply({ ok: false, error: 'bad_address' });
    if (!/^\d{6}$/.test(String(d.code))) return reply({ ok: false, error: 'bad_code' });
    if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, error: 'quota' });

    // The email text lives here, not on the Worker, so this script can only ever send a sign-in code.
    const code = String(d.code);
    MailApp.sendEmail({
      to: d.to,
      name: 'IT Study Hub',
      subject: code + ' is your IT Study Hub code',
      body: 'Your IT Study Hub sign-in code is ' + code + '.\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email; nobody can sign in without the code.',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">' +
        '<p style="margin:0 0 12px">Your IT Study Hub sign-in code:</p>' +
        '<p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:0 0 16px">' + code + '</p>' +
        '<p style="color:#555;font-size:13px;margin:0">It expires in 10 minutes. If you did not ask for it, ignore this email; nobody can sign in without the code.</p></div>',
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: 'error' });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

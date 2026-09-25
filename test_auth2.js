import fetch from 'node-fetch';

const url = 'http://smslogin.in/api/mt/SendSMS';

async function testPost(payload, label) {
  try {
    const params = new URLSearchParams(payload);
    const res = await fetch(url + `?${params.toString()}`, {
      method: 'POST',
    });
    const text = await res.text();
    console.log(`${label}: ${res.status} - ${text}`);
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
}

const message = "Your SalonNest verification OTP is 123456.";
const number = "7747911593";
const template_id = "1277178729296112165";

async function run() {
  await testPost({ user: "SALONEST", password: "a6c1394e8d00ba6fe1f6", senderid: "SAONST", channel: "2", DCS: "0", flashsms: "0", number: number, text: message, route: "4", template_id }, "Test 1");
}
run();

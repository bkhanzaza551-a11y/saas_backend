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

async function run() {
  await testPost({ user: "SALONEST", apikey: "a6c1394e8d00ba6fe1f6", senderid: "SAONST", channel: "2", DCS: "0", flashsms: "0", number: number, text: message, route: "4" }, "Test 1");
  await testPost({ username: "SALONEST", password: "a6c1394e8d00ba6fe1f6", sender: "SAONST", to: number, message: message }, "Test 2");
  await testPost({ UserName: "SALONEST", ApiKey: "a6c1394e8d00ba6fe1f6", SenderId: "SAONST", MobileNumbers: number, Message: message }, "Test 3");
  await testPost({ user_id: "SALONEST", api_key: "a6c1394e8d00ba6fe1f6", sender_id: "SAONST", to: number, message: message }, "Test 4");
}
run();

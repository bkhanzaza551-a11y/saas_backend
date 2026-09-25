import fetch from 'node-fetch';

const url = 'http://smslogin.in/api/mt/SendSMS';
const payload = {
  ApiKey: "a6c1394e8d00ba6fe1f6",
  ClientId: "a6c1394e8d00ba6fe1f6",
  SenderId: "SAONST",
  Message: "Your SalonNest verification OTP is 123456.",
  MobileNumbers: "917747911593",
  TemplateId: "1277178729296112165" // Note the capital T and camel casing common in ASP.NET
};

async function testPost() {
  try {
    const res = await fetch(url + `?ApiKey=${payload.ApiKey}&ClientId=${payload.ClientId}&SenderId=${payload.SenderId}&Message=${encodeURIComponent(payload.Message)}&MobileNumbers=${payload.MobileNumbers}&TemplateId=${payload.TemplateId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    console.log(`POST (QueryParams) Response: ${res.status} - ${text}`);
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }

  try {
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text2 = await res2.text();
    console.log(`POST (JSON Body) Response: ${res2.status} - ${text2}`);
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
}

testPost();

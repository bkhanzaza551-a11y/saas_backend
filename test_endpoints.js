import fetch from 'node-fetch'; // wait, node 18 has fetch built-in

const endpoints = [
  'http://smslogin.in/api/mt/SendSMS',
  'http://smslogin.in/api/v2/SendSMS',
  'http://smslogin.in/api/send_http.php',
  'http://smslogin.in/api/send'
];

const apiKey = "a6c1394e8d00ba6fe1f6";
const senderId = "SAONST";
const to = "7747911593";
const message = encodeURIComponent("Your SalonNest verification OTP is 123456.");
const templateId = "1277178729296112165";

async function testEndpoints() {
  for (const url of endpoints) {
    const params1 = `?ApiKey=${apiKey}&ClientId=${apiKey}&SenderId=${senderId}&Message=${message}&MobileNumbers=${to}&TemplateId=${templateId}`;
    const params2 = `?apikey=${apiKey}&sender=${senderId}&mobiles=${to}&message=${message}&template_id=${templateId}`;
    
    try {
      console.log(`Trying ${url + params1}`);
      const res = await fetch(url + params1);
      const text = await res.text();
      console.log(`Response: ${res.status} - ${text.substring(0, 50)}`);
    } catch (e) {
      console.log(`Failed: ${e.message}`);
    }

    try {
      console.log(`Trying ${url + params2}`);
      const res = await fetch(url + params2);
      const text = await res.text();
      console.log(`Response: ${res.status} - ${text.substring(0, 50)}`);
    } catch (e) {
      console.log(`Failed: ${e.message}`);
    }
  }
}

testEndpoints();

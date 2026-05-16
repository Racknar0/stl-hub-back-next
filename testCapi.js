import 'dotenv/config';
import { sendTikTokEvent } from './src/utils/tiktokCapi.js';

async function run() {
  console.log('Testing TikTok CAPI...');
  console.log('TEST CODE IN ENV:', process.env.TIKTOK_TEST_EVENT_CODE);
  await sendTikTokEvent({
    eventName: 'CompleteRegistration',
    eventId: 'test-id-12345-' + Date.now(),
    userEmail: 'realtest' + Date.now() + '@gmail.com',
    userIp: '190.158.12.34', // random colombian IP
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
}

run();

import telegramDownloaderService from './src/services/telegramDownloader.service.js';

async function run() {
    console.log("Testing getEntity with string ID...");
    try {
      await telegramDownloaderService.initClient();
      const entity = await telegramDownloaderService.client.getEntity("-1001226132023");
      console.log("Entity ID:", entity.id.toString());
    } catch(e) {
      console.log("ERROR with string:", e.message);
    }

    console.log("Testing getEntity with number ID...");
    try {
      const entity2 = await telegramDownloaderService.client.getEntity(-1001226132023);
      console.log("Entity ID:", entity2.id.toString());
    } catch(e) {
      console.log("ERROR with number:", e.message);
    }

    process.exit(0);
}

run();

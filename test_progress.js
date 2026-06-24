import telegramDownloaderService from './src/services/telegramDownloader.service.js';

async function run() {
    console.log("Starting quickScanFiles...");
    try {
      const res = await telegramDownloaderService.quickScanFiles('heheStl', (prog) => {
          console.log("PROGRESS EVENT:", prog);
      });
      console.log("DONE:", res);
    } catch(e) {
      console.log("ERROR:", e);
    }
    process.exit(0);
}

run();

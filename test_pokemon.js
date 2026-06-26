import telegramDownloaderService from './src/services/telegramDownloader.service.js';

async function run() {
    console.log("Starting quickScanFiles for Pokemon STL...");
    try {
      const res = await telegramDownloaderService.quickScanFiles('-1001226132023', (prog) => {
          console.log("PROGRESS EVENT:", prog);
      });
      console.log("DONE:", res);
    } catch(e) {
      console.log("ERROR:", e);
    }
    process.exit(0);
}

run();

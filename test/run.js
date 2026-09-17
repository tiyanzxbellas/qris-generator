/* Jalankan seluruh pengujian: node test/run.js (atau npm test) */
const { run } = require('./t.js');

(async () => {
  console.log('QRIS Generator — pengujian\n');
  require('./page.test.js');
  require('./engine.test.js');
  require('./pipeline.test.js');
  await run();
})();

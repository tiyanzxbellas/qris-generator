/* Harness uji kecil (tanpa framework) — jalankan: npm test */
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let pass = 0;
  const fails = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
      console.log('  \u2713 ' + name);
    } catch (err) {
      fails.push({ name, err });
      console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
    }
  }
  console.log('\n' + pass + ' lulus, ' + fails.length + ' gagal (total ' + tests.length + ')');
  if (fails.length) {
    console.log('\nDetail kegagalan:');
    fails.forEach(f => {
      console.log('- ' + f.name);
      console.log('  ' + String((f.err && f.err.stack) || f.err).split('\n').join('\n  '));
    });
    process.exit(1);
  }
}

module.exports = { test, run };

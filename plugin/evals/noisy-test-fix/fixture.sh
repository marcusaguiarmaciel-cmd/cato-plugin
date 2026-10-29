#!/usr/bin/env bash
set -e
mkdir -p src test
cat > package.json <<'J'
{ "name": "fixture", "version": "1.0.0", "private": true, "scripts": { "test": "node --test" } }
J
cat > src/discount.js <<'J'
// Desconto progressivo: 5% acima de 100, 10% acima de 500
function discount(total) {
  if (total > 500) return total * 0.9
  if (total > 100) return total * 0.95
  return total
}
module.exports = { discount }
J
for i in $(seq 1 120); do
cat > test/ok$i.test.js <<J
const test = require('node:test'); const assert = require('node:assert')
test('soma $i', () => { console.log('rodando caso $i com dados de exemplo e log detalhado de depuração'); assert.equal($i + 1, $((i + 1))) })
J
done
cat > test/discount.test.js <<'J'
const test = require('node:test'); const assert = require('node:assert')
const { discount } = require('../src/discount')
test('500 exatos já recebem 10%', () => { assert.equal(discount(500), 450) })
J

const { randomBytes, scrypt: derive, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(derive);
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [scheme, salt, value] = String(encoded).split(':');
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(value || '')) return false;
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(value, 'hex'));
}
const digest = value => createHash('sha256').update(value).digest('hex');
module.exports = { hashPassword, verifyPassword, digest };

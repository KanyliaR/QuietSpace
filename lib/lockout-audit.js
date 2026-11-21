// Observe existing lockout transitions without changing thresholds or adding a scheduler.
async function lockoutEvent(c, account, action, actor = null) {
  const descriptions = {
    account_locked: 'Account locked after failed sign-in attempts',
    account_lockout_expired: 'Expired account lockout detected and cleared',
    account_lockout_cleared: 'Account lockout cleared by login policy change'
  };
  await require('./audit').appendAudit(c, {
    actor, category: 'account', action, description: descriptions[action] + ': ' + account.name,
    entity: 'staff_account', id: account.id,
    previous: { locked: action !== 'account_locked' }, next: { locked: action === 'account_locked' }
  });
}
async function expireLockedAccount(c, account) {
  const [changed] = await c.query('UPDATE staff_users SET locked_until=NULL,failed_attempts=0 WHERE id=? AND locked_until IS NOT NULL AND locked_until<=NOW()', [account.id]);
  if (changed.affectedRows) await lockoutEvent(c, account, 'account_lockout_expired');
  return !!changed.affectedRows;
}
async function observeExpiredLockouts(db, userId = null) {
  const [candidates] = await db.query('SELECT id FROM staff_users WHERE locked_until IS NOT NULL AND locked_until<=NOW()' + (userId === null ? '' : ' AND id=?') + ' ORDER BY id', userId === null ? [] : [userId]);
  for (const candidate of candidates) {
    const c = await db.getConnection();
    try {
      await c.beginTransaction();
      const [[account]] = await c.query('SELECT id,name FROM staff_users WHERE id=? AND locked_until IS NOT NULL AND locked_until<=NOW() FOR UPDATE', [candidate.id]);
      if (account) await expireLockedAccount(c, account);
      await c.commit();
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }
}
module.exports = { lockoutEvent, expireLockedAccount, observeExpiredLockouts };

function primaryStatus(account) {
  if (account.deleted_at || account.account_status === 'deleted') return 'deleted';
  if (account.account_status === 'inactive') return 'inactive';
  if (account.account_status === 'pending_setup' || !account.setup_complete) return 'pending_setup';
  return account.account_status === 'active' ? 'active' : 'inactive';
}
function staffStatus(account, policy) {
  account.primary_status = primaryStatus(account);
  account.is_locked = !!policy.lockoutTime && !!account.lockout_active;
  delete account.lockout_active;
  return account;
}
module.exports = { primaryStatus, staffStatus };

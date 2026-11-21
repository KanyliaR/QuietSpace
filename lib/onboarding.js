const {randomBytes}=require('node:crypto');
const {digest,hashPassword}=require('./passwords');
const {asyncRoute}=require('./http');
const email=require('./invitation-email');
const fail=(status,message)=>{throw Object.assign(Error(message),{status,publicMessage:message});};
const REQUEST_MESSAGE='Account request submitted. An administrator will review your request.';
function person(body,{legacy=false}={}){
 const roles=['admin','security','library_monitor'];
 if(!body||!roles.includes(body.role))fail(400,'Choose an existing staff role');
 let first=body.first_name,last=body.last_name,name;
 if(legacy&&first===undefined&&last===undefined&&typeof body.name==='string'){
  name=body.name.trim();if(!name||name.length>100)fail(400,'A name of up to 100 characters is required');first=last=null;
 }else{
  if(typeof first!=='string'||typeof last!=='string'||!first.trim()||!last.trim()||first.trim().length>49||last.trim().length>50)fail(400,'First and last names are required (up to 49 and 50 characters)');
  first=first.trim();last=last.trim();name=first+' '+last;
 }
 if(typeof body.email!=='string'||body.email.trim().length>255||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()))fail(400,'Enter a valid email address');
 return {name,first_name:first,last_name:last,email:body.email.trim().toLowerCase(),role:body.role};
}
async function issueInvitation(c,user){
 const token=randomBytes(32).toString('hex');
 await c.query('UPDATE staff_invitations SET revoked_at=NOW(3) WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL',[user.id]);
 const [row]=await c.query('INSERT INTO staff_invitations(user_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(NOW(3),INTERVAL 24 HOUR))',[user.id,digest(token)]);
 return {id:row.insertId,token,email:user.email,role:user.role,first_name:user.first_name};
}
async function deliverInvitation(db,invitation){
 const result=await email.sendInvitation(invitation);
 await db.query('UPDATE staff_invitations SET delivery_status=?,provider_id=?,failure_code=? WHERE id=?',[result.status,result.providerId||null,result.code||null,invitation.id]);
 return {invitation_status:result.status,message:result.status==='accepted'?'Account authorized. Brevo accepted the invitation email; delivery is not confirmed.':result.code?.startsWith('brevo_rejected_')?'Account authorized, but Brevo rejected the invitation email. Check the sender/account configuration, then use Resend Invitation to retry safely.':'Account authorized, but invitation email delivery was not confirmed. Check Brevo logs before using Resend Invitation to retry.'};
}
async function rateLimit(db,key,limit,minutes){
 const hash=digest(key);
 await db.query('DELETE FROM onboarding_rate_limits WHERE expires_at<=NOW(3) LIMIT 100');
 await db.query(`INSERT INTO onboarding_rate_limits(bucket_hash,attempts,expires_at) VALUES (?,1,DATE_ADD(NOW(3),INTERVAL ? MINUTE)) ON DUPLICATE KEY UPDATE attempts=IF(expires_at<=NOW(3),1,attempts+1),expires_at=IF(expires_at<=NOW(3),VALUES(expires_at),expires_at)`,[hash,minutes]);
 const [[row]]=await db.query('SELECT attempts FROM onboarding_rate_limits WHERE bucket_hash=?',[hash]);if(row.attempts>limit)fail(429,'Too many attempts. Please try again later.');
}
function installPublicOnboarding(app,{db}){
 app.post('/api/account-requests',asyncRoute(async(req,res)=>{
  await rateLimit(db,'request:'+req.ip,10,15);
  if(!req.body||Object.keys(req.body).some(k=>!['first_name','last_name','email','role'].includes(k)))fail(400,'Unsupported request fields');
  const p=person(req.body),c=await db.getConnection();
  try{await c.beginTransaction();await c.query('SELECT id FROM staff_management_lock WHERE id=1 FOR UPDATE');
   const [[existing]]=await c.query('SELECT id FROM staff_users WHERE LOWER(TRIM(email))=? OR LOWER(username)=? LIMIT 1',[p.email,p.email]);
   const [[pending]]=await c.query('SELECT id FROM staff_account_requests WHERE pending_email=?',[p.email]);
   if(!existing&&!pending)await c.query('INSERT INTO staff_account_requests(full_name,first_name,last_name,email,requested_role) VALUES (?,?,?,?,?)',[p.name,p.first_name,p.last_name,p.email,p.role]);
   await c.commit();
  }catch(e){await c.rollback();throw e;}finally{c.release();}
  res.status(202).json({message:REQUEST_MESSAGE});
 }));
 const tokenOf=req=>{const token=req.body?.token;if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))fail(400,'This setup link is invalid or expired. Contact your library administrator for a new invitation.');return digest(token);};
 async function invitation(c,hash){
  const [[row]]=await c.query(`SELECT i.id,i.user_id FROM staff_invitations i JOIN staff_users u ON u.id=i.user_id
   WHERE i.token_hash=? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW(3)
   AND u.account_status='pending_setup' AND u.setup_complete=FALSE AND u.deleted_at IS NULL FOR UPDATE`,[hash]);
  if(!row)fail(400,'This setup link is invalid or expired. Contact your library administrator for a new invitation.');return row;
 }
 for(const action of ['validate','complete'])app.post('/api/account-setup/'+action,asyncRoute(async(req,res)=>{
  res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
  await rateLimit(db,'setup:'+req.ip,30,15);const hash=tokenOf(req);
  if(Object.keys(req.body).some(k=>!['token','password','confirm_password'].includes(k)))fail(400,'Unsupported setup fields');
  let passwordHash;
  if(action==='complete'){
   const {password,confirm_password}=req.body;
   if(typeof password!=='string'||password.trim().length<12||password.length>256||password!==confirm_password)fail(400,'Use matching passwords of 12–256 characters');
   passwordHash=await hashPassword(password);
  }
  const c=await db.getConnection();try{
   await c.beginTransaction();await c.query('SELECT id FROM staff_management_lock WHERE id=1 FOR UPDATE');const row=await invitation(c,hash);
   if(action==='complete'){
    await c.query("UPDATE staff_users SET password_hash=?,setup_complete=TRUE,account_status='active',failed_attempts=0,locked_until=NULL WHERE id=?",[passwordHash,row.user_id]);
    await c.query('UPDATE staff_invitations SET consumed_at=NOW(3) WHERE id=?',[row.id]);
    await c.query('UPDATE staff_invitations SET revoked_at=NOW(3) WHERE user_id=? AND id<>? AND consumed_at IS NULL AND revoked_at IS NULL',[row.user_id,row.id]);
    await require('./audit').appendAudit(c,{actor:row.user_id,category:'account',action:'account_setup_completed',description:'Staff account password setup completed',entity:'staff_account',id:row.user_id});
   }
   await c.commit();res.json({message:action==='complete'?'Your account has been set up successfully. You can now sign in to QuietSpace.':'Invitation is valid.'});
  }catch(e){await c.rollback();throw e;}finally{c.release();}
 }));
}
module.exports={person,issueInvitation,deliverInvitation,rateLimit,installPublicOnboarding};

const {asyncRoute}=require('./http');
const ROLES=['admin','library_monitor','security'];
const fail=(status,message)=>{throw Object.assign(Error(message),{status,publicMessage:message});};
function fields(body,allowed){if(!body||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail(400,'Unsupported account fields');}
function role(value){if(!ROLES.includes(value))fail(400,'Choose an existing staff role');return value;}
const onboarding=require('./onboarding');
const {staffStatus}=require('./staff-status');
const {readPolicy}=require('./auth-policy');
const {observeExpiredLockouts}=require('./lockout-audit');
const identity=body=>onboarding.person(body,{legacy:true});
const publicColumns='id,name,first_name,last_name,email,username,role,account_status,setup_complete,is_demo,created_at,deleted_at,locked_until,(locked_until>NOW()) AS lockout_active';
function installStaffManagement(app,{db,query,requireRoles,onAccessChanged}){
  const admin=requireRoles('admin');
  onboarding.installPublicOnboarding(app,{db});
  const activity=async(c,actor,action,accountId,requestId,previous,next)=>{
    await c.query(`INSERT INTO staff_management_activity (actor_id,action,account_id,request_id,previous_values,new_values) VALUES (?,?,?,?,?,?)`,[actor,action,accountId,requestId,previous?JSON.stringify(previous):null,next?JSON.stringify(next):null]);
    const descriptions={account_created:'Staff account created',role_changed:'Staff role changed',account_activated:'Staff account activated',account_deactivated:'Staff account deactivated',setup_restored:'Account setup restored',account_deleted:'Staff account deleted',request_approved:'Account request approved',request_declined:'Account request denied',invitation_resent:'Staff setup invitation resent'};
    await require('./audit').appendAudit(c,{actor,category:'account',action,description:descriptions[action]||'Staff account updated',entity:action.startsWith('request_')?'account_request':'staff_account',id:action.startsWith('request_')?requestId:accountId,previous,next});
  };
  async function transaction(req,work){
    const c=await db.getConnection();try{await c.beginTransaction();
      // Serialize administration so concurrent demotions cannot remove the final admin.
      await c.query('SELECT id FROM staff_management_lock WHERE id=1 FOR UPDATE');
      const [actors]=await c.query("SELECT id FROM staff_users WHERE id=? AND role='admin' AND account_status='active' AND setup_complete=TRUE AND deleted_at IS NULL FOR UPDATE",[req.user.id]);
      if(!actors.length)fail(403,'An active Library Admin account is required');
      const result=await work(c);await c.commit();return result;
    }catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')fail(409,'An account or pending request already exists for this email');throw e;}finally{c.release();}
  }
  const idOf=value=>{if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)fail(400,'Invalid record ID');return Number(value);};
  async function create(c,actor,person,requestId=null){
    const [existing]=await c.query('SELECT id FROM staff_users WHERE LOWER(TRIM(email))=? OR LOWER(username)=? FOR UPDATE',[person.email,person.email]);
    if(existing.length)fail(409,'An account already exists for this email');
    const [pending]=await c.query("SELECT id FROM staff_account_requests WHERE pending_email=? FOR UPDATE",[person.email]);
    if(pending.some(r=>r.id!==requestId))fail(409,'Review the existing pending request for this email');
    // Authorization and invitation are committed together; no usable password exists yet.
    const [insert]=await c.query(`INSERT INTO staff_users (name,first_name,last_name,email,username,role,password_hash,is_demo,account_status,setup_complete)
      VALUES (?,?,?,?,NULL,?,'',FALSE,'pending_setup',FALSE)`,[person.name,person.first_name,person.last_name,person.email,person.role]);
    await activity(c,actor,'account_created',insert.insertId,requestId,null,{name:person.name,email:person.email,role:person.role,account_status:'pending_setup'});
    return {id:insert.insertId,invitation:await onboarding.issueInvitation(c,{id:insert.insertId,...person})};
  }
  app.get('/api/admin/staff',admin,asyncRoute(async(req,res)=>{
    const {search='',role:filterRole='',status=''}=req.query;
    if(Object.keys(req.query).some(k=>!['search','role','status'].includes(k))||typeof search!=='string'||search.length>255||typeof filterRole!=='string'||typeof status!=='string')fail(400,'Invalid staff filters');
    if(filterRole)role(filterRole);if(status&&!['active','deleted','legacy','pending_setup'].includes(status))fail(400,'Invalid account status');
    const where=[status==='deleted'?'deleted_at IS NOT NULL':'deleted_at IS NULL'],args=[];
    if(search){where.push('(INSTR(LOWER(name),LOWER(?))>0 OR INSTR(LOWER(email),LOWER(?))>0)');args.push(search,search);}
    if(filterRole){where.push('role=?');args.push(filterRole);}if(status==='active')where.push("account_status='active' AND setup_complete=TRUE");if(status==='legacy')where.push("account_status='inactive'");if(status==='pending_setup')where.push("(account_status='pending_setup' OR (account_status='active' AND setup_complete=FALSE))");
    await observeExpiredLockouts(db);const policy=await readPolicy(query);
    const accounts=await query(`SELECT ${publicColumns} FROM staff_users ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY name,id`,args);
    const [summary]=await query(`SELECT COALESCE(SUM(deleted_at IS NULL),0) total_accounts,COALESCE(SUM(account_status='active' AND setup_complete=TRUE AND deleted_at IS NULL),0) active_accounts,COALESCE(SUM(account_status='inactive' AND deleted_at IS NULL),0) legacy_inactive,COALESCE(SUM(account_status IN ('active','pending_setup') AND deleted_at IS NULL),0) authorized_accounts,
      (SELECT COUNT(*) FROM (SELECT id identity_id FROM staff_users WHERE deleted_at IS NOT NULL OR account_status='deleted' UNION SELECT CAST(entity_id AS UNSIGNED) FROM audit_events WHERE action='account_deleted' AND entity_type='staff_account' AND entity_id REGEXP '^[1-9][0-9]*$') deletions) deleted_accounts,
      (SELECT COUNT(*) FROM staff_account_requests WHERE status='pending') pending_requests FROM staff_users`);
    for(const key of Object.keys(summary))summary[key]=Number(summary[key]);
    const delivery=await query('SELECT i.user_id,i.delivery_status,i.failure_code,i.provider_id,i.created_at FROM staff_invitations i JOIN (SELECT user_id,MAX(id) id FROM staff_invitations GROUP BY user_id) latest ON latest.id=i.id');
    for(const account of accounts){staffStatus(account,policy);const invitation=delivery.find(i=>i.user_id===account.id);account.invitation_status=invitation?.delivery_status||null;account.invitation_failure_code=invitation?.failure_code||null;account.invitation_message_id=invitation?.provider_id||null;}
    res.json({accounts,summary,server_time:new Date().toISOString(),invitations:{configured:!!require('./invitation-email').configuration(),message:require('./invitation-email').configuration()?'Accounts awaiting password setup cannot sign in. Invitation delivery status is shown in Account Details; administrators can resend invitations.':'Email delivery is not configured. Accounts awaiting password setup cannot sign in. Configure email delivery, then use Resend Invitation in Account Details.'}});
  }));
  app.get('/api/admin/staff/:id',admin,asyncRoute(async(req,res)=>{
    const id=idOf(req.params.id);await observeExpiredLockouts(db,id);const policy=await readPolicy(query);
    const [account]=await query(`SELECT ${publicColumns} FROM staff_users WHERE id=?`,[id]);if(!account)fail(404,'Account not found');const [invitation]=await query('SELECT delivery_status,failure_code,provider_id FROM staff_invitations WHERE user_id=? ORDER BY id DESC LIMIT 1',[account.id]);res.json({...staffStatus(account,policy),server_time:new Date().toISOString(),invitation_status:invitation?.delivery_status||null,invitation_failure_code:invitation?.failure_code||null,invitation_message_id:invitation?.provider_id||null});
  }));
  app.post('/api/admin/staff',admin,asyncRoute(async(req,res)=>{
    fields(req.body,['name','first_name','last_name','email','role']);const person=identity(req.body);
    const created=await transaction(req,c=>create(c,req.user.id,person));res.status(201).json({id:created.id,...await onboarding.deliverInvitation(db,created.invitation)});
  }));
  app.post('/api/admin/staff/:id/invitation',admin,asyncRoute(async(req,res)=>{
    fields(req.body,[]);const id=idOf(req.params.id);
    const invitation=await transaction(req,async c=>{
      const [[target]]=await c.query(`SELECT ${publicColumns} FROM staff_users WHERE id=? FOR UPDATE`,[id]);
      if(!target||target.deleted_at||target.setup_complete||target.account_status!=='pending_setup')fail(409,'Only accounts awaiting password setup can receive invitations');
      const [[limit]]=await c.query('SELECT COUNT(*) total,MAX(created_at)>DATE_SUB(NOW(3),INTERVAL 60 SECOND) recent FROM staff_invitations WHERE user_id=? AND created_at>DATE_SUB(NOW(3),INTERVAL 24 HOUR)',[id]);
      if(limit.recent||limit.total>=5)fail(429,'Please wait before resending. A maximum of five invitations per account is allowed in 24 hours.');
      const next=await onboarding.issueInvitation(c,target);await activity(c,req.user.id,'invitation_resent',id,null,null,{role:target.role});return next;
    });res.json(await onboarding.deliverInvitation(db,invitation));
  }));
  app.patch('/api/admin/staff/:id',admin,asyncRoute(async(req,res)=>{
    fields(req.body,['role']);if(req.body.role===undefined)fail(400,'Choose a role change');role(req.body.role);
    const id=idOf(req.params.id);
    const changed=await transaction(req,async c=>{
      const [[target]]=await c.query(`SELECT ${publicColumns} FROM staff_users WHERE id=? FOR UPDATE`,[id]);
      if(!target)fail(404,'Account not found');if(target.deleted_at)fail(409,'Deleted accounts cannot be restored or modified');
      if(id===req.user.id&&target.role!==req.body.role)fail(409,'You cannot change your own role');
      if(target.role===req.body.role)return false;
      if(target.role==='admin'&&target.account_status==='active'&&target.setup_complete){
        const [admins]=await c.query("SELECT id FROM staff_users WHERE role='admin' AND account_status='active' AND setup_complete=TRUE AND deleted_at IS NULL FOR UPDATE");
        if(admins.length<=1)fail(409,'The last active Library Admin must be preserved');
      }
      await c.query('UPDATE staff_users SET role=? WHERE id=?',[req.body.role,id]);
      await activity(c,req.user.id,'role_changed',id,null,{role:target.role},{role:req.body.role});
      await c.query('DELETE FROM staff_sessions WHERE user_id=?',[id]);return true;
    });
    if(changed)onAccessChanged(id);res.json({message:'Role updated. Changed access requires a fresh sign-in.'});
  }));
  app.delete('/api/admin/staff/:id',admin,asyncRoute(async(req,res)=>{
    fields(req.body,['confirm']);if(req.body.confirm!==true)fail(400,'Explicit confirmation is required');const id=idOf(req.params.id);
    const changed=await transaction(req,async c=>{
      if(id===req.user.id)fail(409,'You cannot delete your own authenticated account');
      const [[target]]=await c.query(`SELECT ${publicColumns} FROM staff_users WHERE id=? FOR UPDATE`,[id]);if(!target)fail(404,'Account not found');
      if(target.deleted_at)return false;
      if(target.role==='admin'&&target.account_status==='active'&&target.setup_complete){
        const [admins]=await c.query("SELECT id FROM staff_users WHERE role='admin' AND account_status='active' AND setup_complete=TRUE AND deleted_at IS NULL FOR UPDATE");
        if(admins.length<=1)fail(409,'The last active Library Admin must be preserved');
      }
      // Retain the FK identity/name/role, erase usable credentials and personal preferences.
      await c.query(`UPDATE staff_users SET account_status='deleted',deleted_at=NOW(3),deleted_by=?,
        username=NULL,email=CONCAT('deleted-',id,'@quietspace.invalid'),password_hash='',setup_complete=FALSE,
        notification_preferences=NULL,failed_attempts=0,locked_until=NULL WHERE id=?`,[req.user.id,id]);
      await c.query('UPDATE staff_invitations SET revoked_at=NOW(3) WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL',[id]);
      await c.query('DELETE FROM staff_sessions WHERE user_id=?',[id]);
      await c.query('DELETE FROM staff_notification_state WHERE user_id=?',[id]);
      await activity(c,req.user.id,'account_deleted',id,null,{account_status:target.account_status,role:target.role},{account_status:'deleted'});
      return true;
    });
    if(changed)onAccessChanged(id);res.json({message:changed?'Account deleted. Sign-in access and all sessions have been revoked.':'Account already deleted.'});
  }));
  app.get('/api/admin/account-requests',admin,asyncRoute(async(req,res)=>{
    if(Object.keys(req.query).some(k=>k!=='status')||req.query.status&&!['pending','approved','declined','all'].includes(req.query.status))fail(400,'Invalid request status');
    const status=req.query.status||'pending';res.json(await query(`SELECT r.*,u.name reviewer_name FROM staff_account_requests r LEFT JOIN staff_users u ON u.id=r.reviewed_by ${status==='all'?'':'WHERE r.status=?'} ORDER BY r.submitted_at DESC,r.id DESC`,status==='all'?[]:[status]));
  }));
  app.post('/api/admin/account-requests/:id/review',admin,asyncRoute(async(req,res)=>{
    fields(req.body,['decision','role','confirm_role_change']);const id=idOf(req.params.id),{decision}=req.body;
    if(!['approve','decline'].includes(decision))fail(400,'Choose approve or decline');
    if(decision==='approve')role(req.body.role);
    const result=await transaction(req,async c=>{
      const [rows]=await c.query('SELECT * FROM staff_account_requests WHERE id=? FOR UPDATE',[id]);const request=rows[0];if(!request)fail(404,'Request not found');
      if(request.status!=='pending')fail(409,'This request has already been reviewed');
      if(decision==='approve'&&req.body.role!==request.requested_role&&req.body.confirm_role_change!==true)fail(409,'Confirm the different assigned role before approval');
      const created=decision==='approve'?await create(c,req.user.id,identity({...(request.first_name&&request.last_name?{first_name:request.first_name,last_name:request.last_name}:{name:request.full_name}),email:request.email,role:req.body.role}),id):null;
      const accountId=created?.id||null;
      const status=decision==='approve'?'approved':'declined';
      await c.query('UPDATE staff_account_requests SET status=?,reviewed_by=?,reviewed_at=NOW(3),assigned_role=?,account_id=? WHERE id=?',[status,req.user.id,decision==='approve'?req.body.role:null,accountId,id]);
      await activity(c,req.user.id,'request_'+status,accountId,id,{status:'pending',requested_role:request.requested_role},{status,assigned_role:decision==='approve'?req.body.role:null});
      return {account_id:accountId,invitation:created?.invitation,message:'Request denied and retained in administrative history.'};
    });const {invitation,...publicResult}=result;res.json(invitation?{...publicResult,...await onboarding.deliverInvitation(db,invitation)}:publicResult);
  }));
  app.get('/api/admin/staff-activity',admin,asyncRoute(async(req,res)=>{
    res.json(await query(`SELECT a.*,actor.name actor_name,actor.email actor_email,u.name account_name,u.email account_email,r.full_name request_name,r.email request_email
      FROM staff_management_activity a JOIN staff_users actor ON actor.id=a.actor_id LEFT JOIN staff_users u ON u.id=a.account_id
      LEFT JOIN staff_account_requests r ON r.id=a.request_id ORDER BY a.id DESC LIMIT 100`));
  }));
}
module.exports={installStaffManagement};

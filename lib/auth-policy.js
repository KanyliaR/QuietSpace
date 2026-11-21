const MAX_SESSION_HOURS=8;
const DEFAULT_POLICY=Object.freeze({maxLoginAttempts:5,lockoutMinutes:15,autoLogoutMinutes:30,lockoutTime:true,automaticLogout:true,sessionsExpire:false});
function validatePolicy(value){
 const fail=()=>{throw Object.assign(Error('Invalid security policy: attempts 1–20, lockout 1–1440 minutes, inactivity 1–240 minutes, and explicit boolean protections are required.'),{status:400,publicMessage:'Invalid security policy values'});};
 if(!value||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_POLICY,k)))fail();
 for(const [key,max] of [['maxLoginAttempts',20],['lockoutMinutes',1440],['autoLogoutMinutes',240]])if(!Number.isInteger(value[key])||value[key]<1||value[key]>max)fail();
 for(const key of ['lockoutTime','automaticLogout','sessionsExpire'])if(typeof value[key]!=='boolean')fail();
 return Object.fromEntries(Object.keys(DEFAULT_POLICY).map(k=>[k,value[k]]));
}
function storedPolicy(value){return value==null?{...DEFAULT_POLICY}:validatePolicy(typeof value==='string'?JSON.parse(value):value);}
async function readPolicy(query){const [row]=await query('SELECT security_policy FROM system_settings WHERE id=1');return storedPolicy(row?.security_policy);}
function idleClause(policy,alias='s'){return policy.automaticLogout?` AND ${alias}.last_seen>DATE_SUB(NOW(),INTERVAL ${policy.autoLogoutMinutes} MINUTE)` : '';}
module.exports={MAX_SESSION_HOURS,DEFAULT_POLICY,validatePolicy,storedPolicy,readPolicy,idleClause};

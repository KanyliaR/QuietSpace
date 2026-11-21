(()=>{
 const $=id=>document.getElementById(id),form=$('setupForm'),message=$('setupMessage');let token=new URLSearchParams(location.search).get('token');history.replaceState(null,'',location.pathname);
 document.body.classList.add(localStorage.getItem('quietspace_theme')==='light'?'light-theme':'dark-theme');
 const show=(text,type='error')=>{message.textContent=text;message.className='message-box '+type;};
 async function api(action,body){const r=await fetch('/api/account-setup/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-QuietSpace-Request':'1'},body:JSON.stringify({token,...body})});const data=await r.json();if(!r.ok)throw Error(data.message||'Unable to complete setup. Please try again.');return data;}
 api('validate',{}).then(()=>{form.hidden=false;}).catch(error=>show(error.message));
 form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');if(button.disabled)return;button.disabled=true;
  try{const data=await api('complete',{password:$('newPassword').value,confirm_password:$('confirmPassword').value});token=null;form.reset();form.hidden=true;show(data.message,'success');$('returnToLogin').focus();}
  catch(error){show(error.message);}finally{button.disabled=false;}
 };
})();

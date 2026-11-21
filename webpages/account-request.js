(()=>{
 const $=id=>document.getElementById(id),form=$('accountRequestForm'),login=$('loginForm'),confirmation=$('requestConfirmation'),title=document.querySelector('.title'),subtitle=document.querySelector('.subtitle');
 const originalSubtitle=subtitle.textContent;
 function show(request){login.hidden=request;form.hidden=!request;confirmation.hidden=true;title.textContent=request?'Request an Account':'Staff Login';subtitle.textContent=request?'Request staff access. A Library Admin must review and approve your requested role.':originalSubtitle;$('messageBox').className='message-box';(request?$('requestFirstName'):$('email')).focus();}
 $('requestAccountButton').onclick=()=>show(true);$('backToLogin').onclick=$('acknowledgeRequest').onclick=()=>show(false);
 form.onsubmit=async event=>{event.preventDefault();const button=$('submitAccountRequest');if(button.disabled)return;button.disabled=true;
  try{const response=await fetch('/api/account-requests',{method:'POST',headers:{'Content-Type':'application/json','X-QuietSpace-Request':'1'},body:JSON.stringify({first_name:$('requestFirstName').value.trim(),last_name:$('requestLastName').value.trim(),email:$('requestEmail').value.trim(),role:$('requestRole').value})});const data=await response.json();if(!response.ok)throw Error(data.message||'Unable to submit request.');form.hidden=true;confirmation.hidden=false;$('messageBox').className='message-box';form.reset();$('acknowledgeRequest').focus();}
  catch(error){showMessage(error.message,'error');}finally{button.disabled=false;}
 };
})();

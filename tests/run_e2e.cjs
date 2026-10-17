const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const baseDir = path.resolve(__dirname, '..');
const dataDir = path.join(require('node:os').tmpdir(), 'gymsaathi_qr_e2e_review_data');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.DATA_DIR = dataDir;
process.env.ADMIN_EMAIL = 'owner@example.test';
process.env.ADMIN_PASSWORD = 'StrongAdmin123!';
delete process.env.GEMINI_API_KEY;
delete process.env.MONGODB_URI;
delete process.env.REDIS_URL;
const serverMod = require(path.join(baseDir, 'server.js'));
const db = require(path.join(baseDir, 'lib/db.js'));
const ai = require(path.join(baseDir, 'lib/ai.js'));
const indiaDay=(d=new Date())=>{const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}); const parts=Object.fromEntries(f.formatToParts(d).map(p=>[p.type,p.value])); return `${parts.year}-${parts.month}-${parts.day}`;};
const checks=[];
function ok(name, pass, detail='') { checks.push({name,pass:!!pass,detail}); if (!pass) console.error('FAIL:',name,detail); else console.log('PASS:',name,detail); }
function assert(cond,msg) { if (!cond) throw new Error(msg); }
function parseCookie(res, cookieName) {
 const v = res.headers.get('set-cookie') || '';
 const m = new RegExp('(?:^|,\\s*)('+cookieName+'=[^;,]+)').exec(v);
 return m ? m[1] : '';
}
async function main(){
 const srv = await serverMod.start(0);
 const origin = `http://127.0.0.1:${srv.address().port}`;
 async function req(path, {method='GET',body, cookie='', headers={}}={}){
   const h={...headers}; if(body!==undefined){h['content-type']='application/json';}
   if(cookie) h.cookie=cookie;
   const res=await fetch(origin+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
   const text=await res.text(); let json; try{json=JSON.parse(text)}catch{json=text};
   return {res,json,text,headers:res.headers};
 }
 try {
   const ping=await req('/ping'); ok('server starts and ping works',ping.res.status===200 && ping.text==='ok',`status=${ping.res.status}`);
   const unauth=await req('/api/data'); ok('private API denied to unauthenticated request',unauth.res.status===401,`status=${unauth.res.status}`);
   const adminLogin=await req('/api/auth/login',{method:'POST',body:{email:'owner@example.test',password:'StrongAdmin123!'}});
   const adminCookie=parseCookie(adminLogin.res,'sid'); ok('admin login',adminLogin.res.status===200 && !!adminCookie,`status=${adminLogin.res.status}`);
   const create=await req('/api/admin/gyms',{method:'POST',cookie:adminCookie,body:{email:'testgym@example.test',password:'StrongGym123!',name:'Test Gym',owner:'Owner Test',phone:'9876543210',timings:'5am-10pm',amenities:'Cardio',price1:500,price3:1300,price6:2400,price12:4500,ptPrice:100,dietPrice:50,staff:[]}});
   ok('create gym through admin API',create.res.status===200 && !!create.json.id,`status=${create.res.status} body=${JSON.stringify(create.json)}`);
   const gymId=create.json.id;
   const gymLogin=await req('/api/auth/login',{method:'POST',body:{email:'testgym@example.test',password:'StrongGym123!'}});
   const gymCookie=parseCookie(gymLogin.res,'sid'); ok('gym login',gymLogin.res.status===200 && !!gymCookie,`status=${gymLogin.res.status}`);
   let dataR=await req('/api/data',{cookie:gymCookie}); const data0=dataR.json;
   ok('GET /api/data has gym and generated join token',dataR.res.status===200 && data0.gym && /^[a-f0-9]{48}$/.test(data0.joinToken||''),`status=${dataR.res.status} joinToken=${!!data0.joinToken}`);
   const token=data0.joinToken;
   const details={...data0.gym,name:'Test Gym',owner:'Owner Test',phone:'9876543210',address:'Bhilwara',timings:'5am-10pm',amenities:'Cardio, weights',upi:'test@upi',price1:500,price3:1300,price6:2400,price12:4500,ptPrice:100,dietPrice:50,staff:[{name:'Rohit Sharma',phone:'9598908555',designation:'Trainer'}]};
   const saveSettings=await req('/api/gym',{method:'PUT',cookie:gymCookie,body:details});
   ok('Settings save staff/prices/details',saveSettings.res.status===200 && saveSettings.json.staff?.[0]?.name==='Rohit Sharma',`status=${saveSettings.res.status}`);
   dataR=await req('/api/data',{cookie:gymCookie});
   ok('Settings persist across GET /api/data',dataR.json.gym?.staff?.[0]?.name==='Rohit Sharma' && dataR.json.gym?.price1===500,`staff=${dataR.json.gym?.staff?.length||0}`);
   const page=await req(`/join/${token}`);
   ok('public QR page loads and is limited join page',page.res.status===200 && page.text.includes('New member registration') && !page.text.includes('href="#/dashboard"'),`status=${page.res.status}`);
   const first=await req(`/api/public/join/${token}`);
   ok('first scan has no member cookie -> first_visit',first.res.status===200 && first.json.status==='first_visit',`status=${first.res.status} response=${JSON.stringify(first.json)}`);
   const createdMember=await req('/api/members',{method:'POST',cookie:gymCookie,body:{name:'Existing Active',phone:'9876543211',months:1,paid:0,start:indiaDay()}});
   ok('normal member registration saves via backend',createdMember.res.status===200 && createdMember.json.name==='Existing Active',`status=${createdMember.res.status}`);
   const lookup=await req(`/api/public/join/${token}/lookup`,{method:'POST',body:{name:'Existing Active',phone:'9876543211'}});
   const memberCookie=parseCookie(lookup.res,`gs_member_${token}`);
   ok('first existing-member verification creates session + attendance',lookup.res.status===200 && lookup.json.status==='present' && !!memberCookie && /HttpOnly/i.test(lookup.res.headers.get('set-cookie')||''),`status=${lookup.res.status}; result=${lookup.json.status}; cookie=${!!memberCookie}`);
   const repeat=await req(`/api/public/join/${token}`,{cookie:memberCookie});
   ok('second scan recognizes from cookie; no name/phone required',repeat.res.status===200 && repeat.json.status==='already' && repeat.json.recognized===true,`status=${repeat.res.status}; result=${repeat.json.status}`);
   let after=await req('/api/data',{cookie:gymCookie});
   const nAttendance=(after.json.attendance||[]).filter(x=>x.id===createdMember.json.id).length;
   ok('dashboard data reflects QR attendance exactly once',nAttendance===1,`member rows=${after.json.members?.length}; attendance matches=${nAttendance}`);
   const switchMember=await req(`/api/public/join/${token}/logout`,{method:'POST',cookie:memberCookie,body:{}});
   ok('switch member revokes cookie/session',switchMember.res.status===200 && switchMember.json.status==='first_visit' && /Max-Age=0/i.test(switchMember.res.headers.get('set-cookie')||''),`status=${switchMember.res.status}`);
   const afterLogout=await req(`/api/public/join/${token}`,{cookie:memberCookie});
   ok('revoked cookie no longer recognizes member',afterLogout.res.status===200 && afterLogout.json.status==='first_visit',`status=${afterLogout.res.status}`);
   const bad=await req(`/api/public/join/${token}/lookup`,{method:'POST',body:{name:'Wrong Name',phone:'9876543211'}});
   ok('wrong name does not attach existing membership',bad.res.status===200 && bad.json.status==='mismatch',`status=${bad.res.status}; ${bad.json.status}`);
   const newLookup=await req(`/api/public/join/${token}/lookup`,{method:'POST',body:{name:'New QR Person',phone:'9876543212'}});
   ok('unknown phone enters self-registration path',newLookup.res.status===200 && newLookup.json.status==='new',`status=${newLookup.res.status}`);
   const reg=await req(`/api/public/join/${token}/register`,{method:'POST',body:{name:'New QR Person',phone:'9876543212',months:1,gender:'Female',age:24,batch:'Morning',goal:'Fitness',accept:true}});
   const regCookie=parseCookie(reg.res,`gs_member_${token}`);
   ok('QR self-registration creates member + membership + 0 paid + session + attendance',reg.res.status===200 && reg.json.status==='registered' && reg.json.active===true && reg.json.attendanceMarked===true && reg.json.due===500 && !!regCookie,`status=${reg.res.status}; payload=${JSON.stringify(reg.json)}`);
   const regScan=await req(`/api/public/join/${token}`,{cookie:regCookie});
   ok('registered user auto-checks in on next QR scan',regScan.res.status===200 && regScan.json.status==='already' && regScan.json.memberName==='New QR Person',`status=${regScan.res.status}; result=${regScan.json.status}`);
   const duplicateReg=await req(`/api/public/join/${token}/register`,{method:'POST',body:{name:'Second QR Person',phone:'9876543212',months:1,accept:true}});
   ok('duplicate phone registration blocked',duplicateReg.res.status===409,`status=${duplicateReg.res.status}`);
   after=await req('/api/data',{cookie:gymCookie});
   const regMember=after.json.members.find(m=>m.phone==='9876543212');
   ok('new QR person appears in gym database-backed page data',!!regMember && regMember.name==='New QR Person' && regMember.fee===500 && regMember.paid===0 && (after.json.attendance||[]).some(a=>a.id===regMember.id),`found=${!!regMember}; fee=${regMember?.fee}; paid=${regMember?.paid}`);
   const expiredStart='2020-01-01';
   const expiredMember=await req('/api/members',{method:'POST',cookie:gymCookie,body:{name:'Expired QR Person',phone:'9876543213',months:1,paid:0,start:expiredStart}});
   const expiredLookup=await req(`/api/public/join/${token}/lookup`,{method:'POST',body:{name:'Expired QR Person',phone:'9876543213'}});
   const expCookie=parseCookie(expiredLookup.res,`gs_member_${token}`);
   ok('expired membership blocks check-in but identifies member',expiredLookup.res.status===200 && expiredLookup.json.status==='inactive' && !!expCookie,`status=${expiredLookup.res.status}; result=${expiredLookup.json.status}`);
   const expScan=await req(`/api/public/join/${token}`,{cookie:expCookie});
   ok('repeat scan keeps expired member inactive',expScan.res.status===200 && expScan.json.status==='inactive',`result=${expScan.json.status}`);
   after=await req('/api/data',{cookie:gymCookie});
   ok('expired member has no attendance record for today',!(after.json.attendance||[]).some(a=>a.id===expiredMember.json.id),`today attendance=${after.json.attendance?.length}`);
   // Assistant: staff response and new-registration intent, using local fallback (no Gemini API key).
   const chatStaff=await req('/api/chat',{method:'POST',cookie:gymCookie,body:{question:'staff me kon kon h?'}});
   ok('assistant answers staff list from gym settings',chatStaff.res.status===200 && JSON.stringify(chatStaff.json).includes('Rohit Sharma') && JSON.stringify(chatStaff.json).includes('9598908555'),`status=${chatStaff.res.status}; body=${JSON.stringify(chatStaff.json).slice(0,250)}`);
   const chatNew=await req('/api/chat',{method:'POST',cookie:gymCookie,body:{question:'naya member add karo'}});
   ok('assistant “naya member add” starts registration',chatNew.res.status===200 && chatNew.json.start==='register',`status=${chatNew.res.status}; body=${JSON.stringify(chatNew.json)}`);
   // Simulate the voice/text registration turn flow without Gemini; required fields must be acquired and form can complete.
   let turn=await req('/api/register/turn',{method:'POST',cookie:gymCookie,body:{form:{},asked:'',said:'',tries:0,spoken:false}});
   let form=turn.json.form||{}, asked=turn.json.next; const answers={name:'Assistant Member',phone:'9876543214',gender:'skip',age:'skip',weight:'skip',height:'skip',goal:'skip',health:'skip',batch:'skip',pt:'skip',diet:'skip',months:'1',paid:'0'};
   let steps=0;
   while(asked && steps<20){
      const said=answers[asked] ?? 'skip';
      turn=await req('/api/register/turn',{method:'POST',cookie:gymCookie,body:{form,asked,said,tries:0,spoken:false}});
      if(turn.res.status!==200) break;
      form=turn.json.form||form; asked=turn.json.next; steps++;
   }
   ok('assistant registration dialogue reaches review/save confirmation',turn.res.status===200 && turn.json.done===true && turn.json.form?.name==='Assistant Member' && turn.json.form?.months===1 && turn.json.form?.paid===0,`http=${turn.res.status}; steps=${steps}; next=${asked}; response=${JSON.stringify(turn.json).slice(0,240)}`);
   const assistantSaved=await req('/api/members',{method:'POST',cookie:gymCookie,body:{...turn.json.form,fee:turn.json.fee,mode:'Cash'}});
   const assistantAfter=await req('/api/data',{cookie:gymCookie});
   ok('assistant-confirmed member save persists to database-backed member list',assistantSaved.res.status===200 && assistantSaved.json.name==='Assistant Member' && assistantAfter.json.members.some(m=>m.name==='Assistant Member' && m.phone==='9876543214' && m.paid===0),`status=${assistantSaved.res.status}; found=${assistantAfter.json.members.some(m=>m.name==='Assistant Member')}`);
   // Backup data from the gym and daily snapshot/restore via owner routes.
   const backup=await req('/api/backup',{cookie:gymCookie});
   ok('downloadable gym backup includes members and QR attendance',backup.res.status===200 && Array.isArray(backup.json.customers) && Array.isArray(backup.json.memberships) && Array.isArray(backup.json.transactions) && Array.isArray(backup.json.attendance) && backup.json.attendance.length>=2,`status=${backup.res.status}; customers=${backup.json.customers?.length}; attendances=${backup.json.attendance?.length}`);
   await serverMod.daily();
   const backups=await req(`/api/admin/gyms/${gymId}/backups`,{cookie:adminCookie});
   const todayBackup=backups.json.find(b=>b.date===indiaDay());
   ok('daily snapshot stored with today date',backups.res.status===200 && backups.json.length>0 && !!todayBackup,`status=${backups.res.status}; dates=${(backups.json||[]).map(x=>x.date).join(',')}`);
   const snap=await db.find('backups',{_id:`${gymId}:${indiaDay()}`});
   let snapshotData=null; try { snapshotData=JSON.parse(zlib.gunzipSync(Buffer.from(snap[0].data,'base64')).toString()); } catch {}
   ok('automatic snapshot payload contains attendance',!!snapshotData && Array.isArray(snapshotData.attendance),`attendances=${snapshotData?.attendance?.length}`);
   // Now create a post-snapshot member, then restore today's snapshot (isolated test DB only).
   const late=await req('/api/members',{method:'POST',cookie:gymCookie,body:{name:'After Backup Member',phone:'9876543215',months:1,paid:0}});
   const restore=await req(`/api/admin/gyms/${gymId}/backups`,{method:'POST',cookie:adminCookie,body:{date:indiaDay()}});
   const afterRestore=await req('/api/data',{cookie:gymCookie});
   ok('daily backup restore restores attendance and removes post-snapshot member',restore.res.status===200 && !(afterRestore.json.members||[]).some(m=>m.phone==='9876543215') && Array.isArray(afterRestore.json.attendance) && afterRestore.json.attendance.length>=2,`restore=${restore.res.status}; restoredMembers=${restore.json?.members}; attendance=${afterRestore.json.attendance?.length}`);
   const gzipBackup=await req('/api/admin/backup',{cookie:adminCookie});
   let adminBackupJson=null; try { adminBackupJson=JSON.parse(zlib.gunzipSync(Buffer.from(gzipBackup.text,'binary')).toString()); } catch {}
   // Fetch as arrayBuffer to properly parse gzip since text() may alter bytes; redo request explicitly.
   const rawAdmin=await fetch(origin+'/api/admin/backup',{headers:{cookie:adminCookie}}); let parsedAdmin=null; try{ parsedAdmin=JSON.parse(zlib.gunzipSync(Buffer.from(await rawAdmin.arrayBuffer())).toString());}catch{}
   ok('service owner compressed backup includes attendance collection',rawAdmin.status===200 && Array.isArray(parsedAdmin?.attendance),`status=${rawAdmin.status}; attendance rows=${parsedAdmin?.attendance?.length}`);
   // Ensure routes hidden from a public visitor.
   const publicData=await req('/api/data');
   ok('public visitor still cannot read management data',publicData.res.status===401,`status=${publicData.res.status}`);
   const badToken=await req('/join/'+('a'.repeat(48)));
   ok('invalid QR route rejected',badToken.res.status===404,`status=${badToken.res.status}`);
   // backup restore a before-restore snapshot is visible (and can be selected) after restore.
   const backups2=await req(`/api/admin/gyms/${gymId}/backups`,{cookie:adminCookie});
   ok('pre-restore copy is kept for rollback',backups2.res.status===200 && backups2.json.some(b=>b.date==='before restore'),`dates=${backups2.json.map(b=>b.date).join(',')}`);
   // HTTP static assets load.
   const joinjs=await req('/join.js'); const css=await req('/join.css');
   ok('QR page JS/CSS served',joinjs.res.status===200 && joinjs.text.includes('/api/public/join/') && css.res.status===200,`js=${joinjs.res.status}; css=${css.res.status}`);
 } finally {
   srv.close();
 }
 console.log('\nRESULT',checks.filter(x=>x.pass).length,'/',checks.length,'passed');
 console.log(JSON.stringify(checks.filter(x=>!x.pass),null,2));
 if(checks.some(x=>!x.pass)) process.exitCode=1;
}
main().catch(e=>{console.error('FATAL E2E:',e.stack||e);process.exitCode=2;});

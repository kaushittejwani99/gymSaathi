'use strict';
const fs = require('node:fs');
const path = require('node:path');
const baseDir = path.resolve(__dirname, '..');
const dataDir = path.join(require('node:os').tmpdir(), 'gymsaathi_qr_edges_data');
fs.rmSync(dataDir, {recursive:true, force:true});
process.env.DATA_DIR=dataDir;
process.env.ADMIN_EMAIL='edge-owner@example.test';
process.env.ADMIN_PASSWORD='StrongAdmin123!';
process.env.GEMINI_API_KEY = ''; process.env.MONGODB_URI = ''; process.env.REDIS_URL = '';
const server = require(path.join(baseDir, 'server.js'));
const db = require(path.join(baseDir, 'lib/db.js'));
const indiaDay=(d=new Date())=>{const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'});const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
const addDays=(s,n)=>new Date(Date.parse(`${s}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
const checks=[]; function check(name,pass,detail=''){checks.push({name,pass:!!pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` — ${detail}`:''}`);}
function cookie(res,name){const h=res.headers.get('set-cookie')||'';return (new RegExp('(?:^|,\\s*)('+name+'=[^;,]+)').exec(h)||[])[1]||'';}
async function main(){
 const srv=await server.start(0), origin=`http://127.0.0.1:${srv.address().port}`;
 async function req(url,{method='GET',body,cookie:ck='',headers={}}={}){const h={...headers};if(body!==undefined)h['content-type']='application/json';if(ck)h.cookie=ck;const res=await fetch(origin+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const text=await res.text();let json;try{json=JSON.parse(text)}catch{json=text}return {res,text,json};}
 try{
  let r=await req('/api/auth/login',{method:'POST',body:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}});const admin=cookie(r.res,'sid');check('Edge test admin login',r.res.status===200&&!!admin,`HTTP ${r.res.status}`);
  async function makeGym({email,name,price1=500,price3=1300,price6=2400,price12=4500}){const c=await req('/api/admin/gyms',{method:'POST',cookie:admin,body:{email,password:'StrongGym123!',name,owner:'Owner',phone:'9876543210',timings:'6 AM–10 PM',amenities:'Weights',price1,price3,price6,price12}});if(c.res.status!==200)throw Error('create gym failed '+c.text);const l=await req('/api/auth/login',{method:'POST',body:{email,password:'StrongGym123!'}});const sid=cookie(l.res,'sid');const d=await req('/api/data',{cookie:sid});return {id:c.json.id,cookie:sid,token:d.json.joinToken,details:d.json.gym};}
  const A=await makeGym({email:'a@example.test',name:'Gym Alpha'});const B=await makeGym({email:'b@example.test',name:'Gym Beta'});const C=await makeGym({email:'c@example.test',name:'Gym Quarterly',price1:500,price3:1200,price6:0,price12:0});
  // Exercise a legacy/edge configuration: the QR route should honor a configured 3-month plan even with price1 absent.
  await db.update('gyms',{_id:C.id},{details:{...C.details,price1:0,price3:1200,price6:0,price12:0}}); server.forget(C.id);
  check('Each gym receives a unique 48-hex QR token',A.token!==B.token&&B.token!==C.token&&[A.token,B.token,C.token].every(t=>/^[a-f0-9]{48}$/.test(t)));
  const pubA=await req(`/api/public/join/${A.token}`),pubB=await req(`/api/public/join/${B.token}`);
  check('QR page content resolves to the correct gym',pubA.json.gym.name==='Gym Alpha'&&pubB.json.gym.name==='Gym Beta');
  const pubC = (await req(`/api/public/join/${C.token}`)).json;
  check('Quarterly-only plan still enables QR registration',pubC.canRegister===true && pubC.plans.some(p=>p.months===3&&p.fee===1200),JSON.stringify(pubC.plans));
  const today=indiaDay();
  const createMember=async(gym,name,phone,start=today,months=1)=>req('/api/members',{method:'POST',cookie:gym.cookie,body:{name,phone,months,paid:0,start}});
  const mA=await createMember(A,'Shared Phone Alpha','9876543211');const mB=await createMember(B,'Shared Phone Beta','9876543211');
  check('Same phone can belong to separate gyms without cross-contamination',mA.res.status===200&&mB.res.status===200&&mA.json.name!==mB.json.name);
  const aFirst=await req(`/api/public/join/${A.token}/lookup`,{method:'POST',body:{name:'Shared Phone Alpha',phone:'9876543211'}});const cA=cookie(aFirst.res,`gs_member_${A.token}`);const hdrA=aFirst.res.headers.get('set-cookie')||'';
  check('First-time verify sets HttpOnly + SameSite + gym-scoped cookie',aFirst.res.status===200&&aFirst.json.status==='present'&&!!cA&&/HttpOnly/i.test(hdrA)&&/SameSite=Lax/i.test(hdrA)&&hdrA.includes(`Path=/api/public/join/${A.token}`));
  const wrongTokenSession=await req(`/api/public/join/${B.token}`,{cookie:cA});
  check('Gym Alpha device cookie cannot identify member in Gym Beta',wrongTokenSession.res.status===200&&wrongTokenSession.json.status==='first_visit'&&!wrongTokenSession.json.recognized);
  const mismatchB=await req(`/api/public/join/${B.token}/lookup`,{method:'POST',body:{name:'Shared Phone Alpha',phone:'9876543211'}});
  check('Correct phone with wrong gym-member name cannot bind a session',mismatchB.res.status===200&&mismatchB.json.status==='mismatch');
  const invalidPhone=await req(`/api/public/join/${A.token}/lookup`,{method:'POST',body:{name:'Someone',phone:'12345'}});
  check('Invalid mobile number rejected without creating attendance',invalidPhone.res.status===400);
  const noConsent=await req(`/api/public/join/${A.token}/register`,{method:'POST',body:{name:'No Consent',phone:'9876543222',months:1,accept:false}});
  check('Self-registration without consent is rejected',noConsent.res.status===400&&/confirm/i.test(noConsent.json.error||''));
  const invalidRegPhone=await req(`/api/public/join/${A.token}/register`,{method:'POST',body:{name:'Invalid Phone',phone:'12345',months:1,accept:true}});
  check('Self-registration rejects malformed mobile numbers',invalidRegPhone.res.status===400&&/mobile number/i.test(invalidRegPhone.json.error||''));
  const [race1,race2]=await Promise.all([
    req(`/api/public/join/${A.token}/register`,{method:'POST',body:{name:'Concurrent Signup One',phone:'9876543227',months:1,accept:true}}),
    req(`/api/public/join/${A.token}/register`,{method:'POST',body:{name:'Concurrent Signup Two',phone:'9876543227',months:1,accept:true}})
  ]);
  check('Two simultaneous signups with the same gym/mobile create only one member',[race1.res.status,race2.res.status].sort().join(',')==='200,409',`HTTP ${race1.res.status}/${race2.res.status}`);
  const crossA=await req('/api/data',{cookie:A.cookie}),crossB=await req('/api/data',{cookie:B.cookie});
  check('Authenticated dashboard data remains isolated by gym',crossA.res.status===200&&crossB.res.status===200&&(crossA.json.members||[]).some(m=>m.name==='Shared Phone Alpha')&&!(crossA.json.members||[]).some(m=>m.name==='Shared Phone Beta')&&(crossB.json.members||[]).some(m=>m.name==='Shared Phone Beta')&&!(crossB.json.members||[]).some(m=>m.name==='Shared Phone Alpha'));
  const invalidPlan=await req(`/api/public/join/${C.token}/register`,{method:'POST',body:{name:'Invalid Plan',phone:'9876543223',months:1,accept:true}});
  check('Unavailable plan cannot be submitted to registration',invalidPlan.res.status===400&&/available membership plans/i.test(invalidPlan.json.error||''));
  const qReg=await req(`/api/public/join/${C.token}/register`,{method:'POST',body:{name:'Quarterly QR',phone:'9876543224',months:3,accept:true}});const qCookie=cookie(qReg.res,`gs_member_${C.token}`);
  check('Quarterly-only QR registration saves a 3-month ₹1200 plan and leaves it unpaid',qReg.res.status===200&&qReg.json.status==='registered'&&qReg.json.fee===1200&&qReg.json.due===1200&&qReg.json.attendanceMarked===true&&!!qCookie);
  const cData=await req('/api/data',{cookie:C.cookie});const qMember=(cData.json.members||[]).find(m=>m.phone==='9876543224');
  check('New QR registration is reflected in normal gym member data',!!qMember&&qMember.name==='Quarterly QR'&&qMember.paid===0&&qMember.fee===1200&&(cData.json.attendance||[]).some(a=>a.id===qMember.id&&a.name==='Quarterly QR'));
  const nextDay=new Date(Date.parse(`${today}T00:00:00Z`)+86400000);nextDay.setUTCMonth(nextDay.getUTCMonth()-1);const endsTodayStart=nextDay.toISOString().slice(0,10);
  const endsToday=await createMember(A,'Last Valid Day','9876543228',endsTodayStart,1);const lastDayLookup=await req(`/api/public/join/${A.token}/lookup`,{method:'POST',body:{name:'Last Valid Day',phone:'9876543228'}});
  check('Membership is still eligible on its inclusive end date',endsToday.res.status===200&&endsToday.json.end===today&&lastDayLookup.json.status==='present');
  const future=await createMember(A,'Future Start','9876543225',addDays(today,1),1);const futureLookup=await req(`/api/public/join/${A.token}/lookup`,{method:'POST',body:{name:'Future Start',phone:'9876543225'}});
  const dA=await req('/api/data',{cookie:A.cookie});
  check('Membership starting tomorrow is not marked present today',future.res.status===200&&futureLookup.json.status==='inactive'&&!(dA.json.attendance||[]).some(a=>a.id===future.json.id));
  const concurrencyMember=await createMember(A,'Concurrent Scan','9876543226');const firstConcurrent=await req(`/api/public/join/${A.token}/lookup`,{method:'POST',body:{name:'Concurrent Scan',phone:'9876543226'}});const conCookie=cookie(firstConcurrent.res,`gs_member_${A.token}`);
  const [scan1,scan2]=await Promise.all([req(`/api/public/join/${A.token}`,{cookie:conCookie}),req(`/api/public/join/${A.token}`,{cookie:conCookie})]);
  const checkData=await req('/api/data',{cookie:A.cookie});const concurrentCount=(checkData.json.attendance||[]).filter(a=>a.id===concurrencyMember.json.id).length;
  check('Concurrent repeat scans do not create duplicate attendance rows',scan1.res.status===200&&scan2.res.status===200&&concurrentCount===1);
  const invalidToken=await req('/api/public/join/'+('f'.repeat(48)));
  check('Random invalid QR token is not accepted',invalidToken.res.status===404);
  const noConsentPlanAvailable=await req(`/api/public/join/${C.token}`);
  check('Public QR exposes only plan + check-in info, not private member list',noConsentPlanAvailable.res.status===200&&!('members' in noConsentPlanAvailable.json)&&!('payments' in noConsentPlanAvailable.json));
  const mainMarkup=fs.readFileSync(path.join(baseDir,'public/app.js'),'utf8');const styles=fs.readFileSync(path.join(baseDir,'public/styles.css'),'utf8');
  check('Dashboard attendance UI renders ✓ Present + member name + mobile + check-in time',mainMarkup.includes('attendance-tick')&&mainMarkup.includes('✓ Present')&&mainMarkup.includes('a.name')&&mainMarkup.includes('a.phone')&&mainMarkup.includes('Check-in time'));
  check('Chat bubble CSS removes forced tall boxes',/\.msg\s*\{[^}]*height:\s*auto/s.test(styles)&&/\.msg\s*\{[^}]*min-height:\s*0/s.test(styles));
  const total=checks.length,passed=checks.filter(c=>c.pass).length;fs.writeFileSync(path.join(baseDir, 'GymSaathi_QR_Edge_Test_Results.json'),JSON.stringify({environment:'isolated file-backed local test server; no live services',total,passed,failed:total-passed,checks},null,2));console.log(`\nQR EDGE TESTS: ${passed}/${total} passed`);if(passed!==total)process.exitCode=1;
 }finally{srv.close();}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=2;});

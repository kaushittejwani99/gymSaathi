const fs = require('node:fs');
const path = require('node:path');
const baseDir = path.resolve(__dirname, '..');
const dataDir = path.join(require('node:os').tmpdir(), 'gymsaathi_50q_data');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.DATA_DIR = dataDir;
process.env.ADMIN_EMAIL = 'owner@example.test';
process.env.ADMIN_PASSWORD = 'StrongAdmin123!';
process.env.GEMINI_API_KEY = ''; process.env.MONGODB_URI = ''; process.env.REDIS_URL = '';
const serverMod = require(path.join(baseDir, 'server.js'));
const checks=[];
function ok(name, pass, detail='') { checks.push({name,pass:!!pass,detail}); }
function parseCookie(res, cookieName) { const v=res.headers.get('set-cookie')||''; const m=new RegExp('(?:^|,\\s*)('+cookieName+'=[^;,]+)').exec(v); return m?m[1]:''; }
async function main(){
 const srv=await serverMod.start(0); const origin=`http://127.0.0.1:${srv.address().port}`;
 async function req(url,{method='GET',body,cookie='',headers={}}={}){
  const h={...headers}; if(body!==undefined) h['content-type']='application/json'; if(cookie) h.cookie=cookie;
  const res=await fetch(origin+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await res.text(); let json; try{json=JSON.parse(text)}catch{json=text}; return {res,json,text};
 }
 try {
  let r=await req('/api/auth/login',{method:'POST',body:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}}); const adminCookie=parseCookie(r.res,'sid'); if(r.res.status!==200||!adminCookie) throw new Error('admin login failed '+r.text);
  r=await req('/api/admin/gyms',{method:'POST',cookie:adminCookie,body:{email:'qa-gym@example.test',password:'StrongGym123!',name:'QA Gym',owner:'QA Owner',phone:'9876543210',timings:'5 AM to 10 PM',amenities:'Weights, cardio',price1:500,price3:1300,price6:2400,price12:4500,ptPrice:100,dietPrice:50,staff:[{name:'Rohit Sharma',phone:'9598908555',designation:'Trainer'},{name:'Neha Verma',phone:'9598908556',designation:'Reception'}]}});
  if(r.res.status!==200||!r.json.id) throw new Error('create gym failed '+r.text);
  r=await req('/api/auth/login',{method:'POST',body:{email:'qa-gym@example.test',password:'StrongGym123!'}}); const gymCookie=parseCookie(r.res,'sid'); if(r.res.status!==200||!gymCookie) throw new Error('gym login failed '+r.text);
  r=await req('/api/data',{cookie:gymCookie}); const token=r.json.joinToken; if(!token) throw new Error('missing join token');
  const indiaDay=(d=new Date())=>{const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}); const parts=Object.fromEntries(f.formatToParts(d).map(p=>[p.type,p.value])); return `${parts.year}-${parts.month}-${parts.day}`;};
  const today=indiaDay(); const yesterday=(()=>{const d=new Date(Date.now()-86400000); return indiaDay(d);})(); const old='2020-01-01';
  const members=[
   {name:'Aman Singh',phone:'9876543211',months:1,paid:0,start:today,goal:'Muscle gain',gender:'Male',age:28,batch:'Morning'},
   {name:'Priya Jain',phone:'9876543212',months:1,paid:500,start:today,goal:'Fitness',gender:'Female',age:25,batch:'Evening'},
   {name:'Rahul Sharma',phone:'9876543213',months:3,paid:1000,start:today,goal:'Weight loss',gender:'Male',age:30,batch:'Morning'},
   {name:'Muskan Arora',phone:'9876543214',months:1,paid:200,start:today,goal:'Weight loss',gender:'Female',age:24,batch:'Evening'},
   {name:'Expired Guest',phone:'9876543215',months:1,paid:500,start:old,goal:'Fitness',gender:'Male',age:40,batch:'Morning'},
   {name:'Soon Ending',phone:'9876543216',months:1,paid:0,start:new Date(Date.now()-25*86400000).toISOString().slice(0,10),goal:'Fitness'},
  ];
  for (const m of members) { const add=await req('/api/members',{method:'POST',cookie:gymCookie,body:m}); if(add.res.status!==200) throw new Error('add member failed '+m.name+' '+add.text); }
  // Mark one real attendance row using the public QR verification endpoint.
  const seededAttendance = await req(`/api/public/join/${token}/lookup`, {method:'POST', body:{name:'Aman Singh', phone:'9876543211'}});
  if (seededAttendance.res.status !== 200 || seededAttendance.json.status !== 'present') throw new Error('Failed to seed QR attendance: '+seededAttendance.text);
  // Set one payment mode test: paid amounts are persisted as transactions by member creation.
  const questions=[
   ['कुल कितने मेंबर हैं?',/कुल\s+6\s+मेंबर/],
   ['किसकी फीस बाकी है?',/4 मेंबर की फीस बाकी है, कुल ₹1,600[\s\S]*Aman Singh: ₹500[\s\S]*Soon Ending: ₹500[\s\S]*Rahul Sharma: ₹300[\s\S]*Muskan Arora: ₹300/],
   ['Aman Singh की फीस कितनी बाकी है?',/Aman Singh की मेंबरशिप[\s\S]*₹500 बाकी है[\s\S]*बाकी: ₹500/],
   ['Priya Jain की फीस कितनी बाकी है?',/Priya Jain की मेंबरशिप[\s\S]*कोई फीस बाकी नहीं है[\s\S]*बाकी: ₹0/],
   ['Rahul Sharma का मोबाइल नंबर बताओ',/9876543213/],
   ['Muskan Arora का goal क्या है?',/Weight loss|वज़न कम|वजन कम/],
   ['Rahul Sharma की membership कब खत्म होगी?',/Rahul Sharma|\d+ (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/],
   ['कौन-कौन से members active हैं?',/चालू मेंबर: 4 मेंबर।[\s\S]*Aman Singh[\s\S]*Priya Jain[\s\S]*Rahul Sharma[\s\S]*Muskan Arora/],
   ['कितने members expired हैं?',/खत्म हो चुकी मेंबरशिप: 1 मेंबर।[\s\S]*Expired Guest/],
   ['अगले 7 दिनों में किसकी membership खत्म हो रही है?',/Soon Ending|मेंबरशिप/],
   ['इस महीने कितना पैसा आया?',/कुल ₹2,200 \(4 भुगतान\)/],
   ['आज कितना पैसा आया?',/कुल ₹2,200 \(4 भुगतान\)/],
   ['पिछले महीने कितना पैसा आया?',/कुल ₹0 \(0 भुगतान\)/],
   ['Gym ki fees kya hai?',/500|1 महीना|फीस/],
   ['Gym ka timing kya hai?',/5 AM to 10 PM|जिम का समय/],
   ['Staff mein kaun kaun hai?',/Rohit Sharma|Neha Verma/],
   ['Naya member kaise add kare?',/Members|मेंबर|Assistant/],
   ['Naya member add karo',null,'start'],
   ['Old data Excel se kaise import karu?',/Import|Excel|इम्पोर्ट/],
   ['Backup kaise download karu?',/बैकअप|Backup|Settings|डाउनलोड/],
   ['Backup restore kaise hota hai?',/Download किए गए backup[\s\S]*Accounts → Backups/],
   ['Member ki payment kaise record karu?',/पेमेंट|भुगतान|Members|Cash|UPI/],
   ['Membership renew kaise karu?',/रिन्यू|Renew|Members/],
   ['Member ki details update kaise karu?',/जानकारी|बदल|Members|update/i],
   ['Member delete kaise karu?',/हटाने|Delete|Deleted|Members/i],
   ['WhatsApp reminder kaise bheju?',/व्हाट्सऐप|WhatsApp|Dashboard/],
   ['Dashboard mein kya dikhta hai?',/Dashboard|डैशबोर्ड|फीस|मेंबर/],
   ['QR code scan karne par attendance kaise mark hoti hai?',/QR|attendance|उपस्थिति|scan/i],
   ['QR scan do baar karu to duplicate attendance banegi?',/दूसरी attendance entry नहीं बनती[\s\S]*Already checked in/],
   ['Expired member ki attendance mark hogi?',/Membership आज active नहीं है[\s\S]*attendance record नहीं बनाता/],
   ['Invalid QR token par kya hoga?',/QR link invalid दिखे[\s\S]*Settings → Member QR code/],
   ['Agar mobile number already registered hai to kya karu?',/mobile number पहले से दर्ज है[\s\S]*duplicate member/],
   ['What can GymSaathi do?',/GymSaathi|मेंबर|जिम|फीस/],
   ['How do I add a member?',/Members|मेंबर|Assistant|New member/i],
   ['How to import Excel?',/Excel|Import|इम्पोर्ट/],
   ['How do I set gym prices?',/Settings|सेटिंग|फीस/],
   ['How to send WhatsApp reminder?',/WhatsApp|व्हाट्सऐप|Dashboard/],
   ['How do I see members whose fee is pending?',/बाकी फीस वाले मेंबर देखने[\s\S]*Fees pending[\s\S]*Due/],
   ['What are my gym timings?',/जिम का समय: 5 AM to 10 PM/],
   ['Muskan Arora ka mobile number kya hai?',/9876543214/],
   ['1234567890 kis member ka number hai?',/नहीं मिला|कोई मेंबर नहीं|number|नंबर/i],
   ['Rahul Sharma ka status kya hai?',/Rahul Sharma|सक्रिय|active|समाप्त|मेंबरशिप/i],
   ['Kya Priya ki membership active hai?',/Priya Jain की मेंबरशिप[\s\S]*स्थिति: चालू/],
   ['Aaj kiski attendance lagi?',/आज 1 मेंबर की attendance mark हुई है[\s\S]*Aman Singh[\s\S]*✓ Present/],
   ['Kis member ne aaj attendance lagayi?',/आज 1 मेंबर की attendance mark हुई है[\s\S]*Aman Singh[\s\S]*✓ Present/],
   ['Aman ne 500 diye',/Aman Singh|500|कन्फर्म|जमा करूँ|confirm/i],
   ['Aman Singh ko 3 mahine renew kar do',/Aman Singh|रिन्यू|months|कन्फर्म|confirm/i],
   ['Aman Singh ko reminder bhejo',/Aman Singh|reminder|रिमाइंडर|WhatsApp|व्हाट्सऐप/i],
   ['Thanks',/धन्यवाद|खुशी|मदद|welcome|स्वागत/i],
   ['Member QR code ka link kahan milega?',/Settings → \"Member QR code\" section[\s\S]*हर gym का QR अलग है/],
  ];
  const results=[];
  for(let i=0;i<questions.length;i++) {
    const [question, expect, kind]=questions[i];
    const out=await req('/api/chat',{method:'POST',cookie:gymCookie,body:{question,quick:true}});
    const obj=out.json||{}; const answer=String(obj.answer||'');
    let passed=false, reason='';
    if(out.res.status!==200){reason=`HTTP ${out.res.status}: ${out.text}`;}
    else if(kind==='start'){passed=obj.start==='register';reason=`start=${obj.start||'none'}`;}
    else if(!answer.trim() && !obj.start && !obj.run && !obj.do){reason='Empty response';}
    else if(expect && !expect.test(answer)){reason=`Expected pattern ${expect}, got: ${answer.slice(0,220)}`;}
    else {passed=true;reason=`mode=${obj.mode||'action'}, chars=${answer.length}`;}
    results.push({n:i+1,question,answer:answer||JSON.stringify(obj),pass:passed,reason,raw:obj});
    console.log(`${passed?'PASS':'FAIL'} ${i+1}. ${question}\n   ${answer.replace(/\n/g,' | ').slice(0,250)}\n   ${reason}`);
  }
  fs.writeFileSync(path.join(baseDir, 'GymSaathi_50_Assistant_Test_Results.json'),JSON.stringify({env:'isolated local file-backed DB; quick/local fallback; Gemini key removed',questionCount:questions.length,pass:results.filter(x=>x.pass).length,fail:results.filter(x=>!x.pass).length,results},null,2));
  console.log(`\n50-QUESTION RUN: ${results.filter(x=>x.pass).length}/${results.length} assertions passed`);
  console.log('FAILURES',JSON.stringify(results.filter(x=>!x.pass).map(({n,question,answer,reason})=>({n,question,answer,reason})),null,2));
 } finally { srv.close(); }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=2;});

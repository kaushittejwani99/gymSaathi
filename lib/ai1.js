const serverLogs = [
  { endpoint: "/api/login", status: 200, responseTime: 120 },
  { endpoint: "/api/orders", status: 500, responseTime: 3400 },
  { endpoint: "/api/payment", status: 500, responseTime: 5000 },
  { endpoint: "/api/orders", status: 500, responseTime: 2100 },
  { endpoint: "/api/login", status: 401, responseTime: 80 },
  { endpoint: "/api/orders", status: 200, responseTime: 150 },
];

// we have to find the endpoints that have a status of 500 and a response time greater than 2000ms

const filterArray=serverLogs.filter((endpoint,index)=>{
    return endpoint.status==500 
})
var newArray=[]
var a={}
for(let i=0;i<filterArray.length;i++){
    for(let j=0;j<filterArray.length;j++){
         if(filterArray[i].responseTime<filterArray[j+1].responseTime){
            a=filterArray[i]
         }else{
                a=filterArray[j]
         }
     
    }
    newArray.push(a)
}
// i=3400 j=3400 // 
console.log(newArray)
// D backend/minjae service-account contract. Disabled until configured.
class NotificationBridge {
  constructor(service,config,fetcher=fetch){this.service=service;this.config=config;this.fetcher=fetcher;this.cached=null;this.running=false;}
  async token(){
    if(this.cached&&this.cached.expiresAt>Date.now()+30000)return this.cached.token;
    const response=await this.fetcher(this.config.notificationTokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:this.config.notificationClientId,client_secret:this.config.notificationClientSecret}),signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw Error('Service account token failed');
    const data=await response.json();
    if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw Error('Invalid token response');
    this.cached={token:data.access_token,expiresAt:Date.now()+data.expires_in*1000};return data.access_token;
  }
  async flush(){
    if(this.running||!this.config.notificationUrl)return;
    this.running=true;
    try{
      const pending=this.service.state.notifications.filter(n=>n.pushStatus==='PENDING'&&(n.nextAttemptAt||0)<=Date.now()).slice(0,10);
      for(const item of pending){
        let result,error;
        try{
          const token=await this.token();
          const response=await this.fetcher(this.config.notificationUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({eventId:item.id,userId:this.config.notificationUserId,title:'자취방 원격 케어',body:item.message,data:{commandId:item.commandId||'',type:'room.notification'}}),signal:AbortSignal.timeout(5000),redirect:'error'});
          if(response.status===401)this.cached=null;
          if(!response.ok)throw Error('Notification service request failed');
          result=await response.json();
          if(!['sent','dry-run','duplicate','partial-failure','no-targets'].includes(result.status))throw Error('Unknown notification result');
        }catch{error=true;}
        await this.service.run(()=>{
          const n=this.service.state.notifications.find(n=>n.id===item.id);if(!n)return;
          n.pushAttempts=(n.pushAttempts||0)+1;
          if(error){n.pushStatus=n.pushAttempts>=3?'FAILED':'PENDING';n.nextAttemptAt=Date.now()+30000;}
          else{n.pushStatus=result.status.toUpperCase();n.pushResult={status:result.status,targetCount:result.targetCount??null,successCount:result.successCount??null};}
        });
      }
    }finally{this.running=false;}
  }
}
module.exports={NotificationBridge};

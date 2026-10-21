const {timingSafeEqual}=require('node:crypto');
const {ApiError}=require('./validation');
function bearer(req){return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization||'')?.[1];}
function equal(a,b){if(typeof a!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
async function createAuthenticator(config,localKeys){
  if(config.jwtIssuer){
    const {jwtVerify,createRemoteJWKSet}=await import('jose');
    const keys=localKeys||createRemoteJWKSet(new URL(config.jwtJwks));
    return {required:true,async verify(token){
      let payload;
      try{({payload}=await jwtVerify(token,keys,{issuer:config.jwtIssuer,audience:config.jwtAudience,algorithms:['RS256']}));}
      catch{throw new ApiError(401,'유효한 로그인 토큰이 필요합니다.');}
      if(typeof payload.sub!=='string'||typeof payload.exp!=='number')throw new ApiError(401,'사용자 또는 만료 정보가 없습니다.');
      if(!config.allowedSubjects.includes(payload.sub))throw new ApiError(403,'이 공간에 접근할 권한이 없습니다.');
      return payload;
    }};
  }
  return {required:Boolean(config.apiToken),async verify(token){
    if(config.apiToken&&!equal(token,config.apiToken))throw new ApiError(401,'인증이 필요합니다.');
    return {sub:'local-dev-user'};
  }};
}
module.exports={createAuthenticator,bearer};

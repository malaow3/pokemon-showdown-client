"use strict";
var POKEBIN_BASE=function(_Config){


if(location.hostname==='localhost'||location.hostname==='127.0.0.1'){
return'http://localhost:2000';
}


if(location.hostname==='showdown.malaow3.com'){
return'https://pokebin.malaow3.com';
}
var host=((_Config=globalThis.Config)==null?void 0:_Config.pokebinHost)||'pokebin.malaow3.com';
return host.startsWith('http://')||host.startsWith('https://')?host:"https://"+host;
}();

var TOKEN_KEY='pokebin_access_token';
var EXPIRY_KEY='pokebin_token_expiry';

function base64UrlEncode(bytes){
var str='';
for(var i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);
return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}

function randomString(){var len=arguments.length>0&&arguments[0]!==undefined?arguments[0]:32;
var bytes=new Uint8Array(len);
crypto.getRandomValues(bytes);
return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier){
var data=new TextEncoder().encode(verifier);
var digest=await crypto.subtle.digest('SHA-256',data);
return base64UrlEncode(new Uint8Array(digest));
}

function getPokebinBase(){
return POKEBIN_BASE;
}


var REFRESH_TOKEN_KEY='pokebin_refresh_token';
var REFRESH_EXPIRY_KEY='pokebin_refresh_expiry';
var REFRESH_SKEW_MS=60*1000;
var authGeneration=0;
var refreshRequest=null;









function getPokebinAccessToken(){
var token=localStorage.getItem(TOKEN_KEY);
var expiry=localStorage.getItem(EXPIRY_KEY);
if(expiry&&Date.now()>=Number(expiry))return null;
return token;
}

function getPokebinRefreshToken(){
var expiry=localStorage.getItem(REFRESH_EXPIRY_KEY);
if(expiry&&Date.now()>=Number(expiry))return null;
return localStorage.getItem(REFRESH_TOKEN_KEY);
}

function isPokebinLoggedIn(){
return!!(getPokebinAccessToken()||getPokebinRefreshToken());
}

function forgetPokebinAuth(){
authGeneration++;
refreshRequest=null;
localStorage.removeItem(TOKEN_KEY);
localStorage.removeItem(EXPIRY_KEY);
localStorage.removeItem(REFRESH_TOKEN_KEY);
localStorage.removeItem(REFRESH_EXPIRY_KEY);
sessionStorage.removeItem('pokebin_verifier');
sessionStorage.removeItem('pokebin_state');
}

function revokePokebinToken(refreshToken){

void fetch(POKEBIN_BASE+"/api/oauth/revoke",{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({client_id:'showdown-web',refresh_token:refreshToken})
})["catch"](function(){});
}

function clearPokebinAuth(){
var refreshToken=localStorage.getItem(REFRESH_TOKEN_KEY);
forgetPokebinAuth();
if(refreshToken)revokePokebinToken(refreshToken);
}

function setPokebinToken(json){
localStorage.setItem(TOKEN_KEY,json.access_token);
localStorage.setItem(EXPIRY_KEY,String(Date.now()+json.expires_in*1000));
if(json.refresh_token){
localStorage.setItem(REFRESH_TOKEN_KEY,json.refresh_token);
if(json.refresh_expires_in){
localStorage.setItem(REFRESH_EXPIRY_KEY,String(Date.now()+json.refresh_expires_in*1000));
}else{
localStorage.removeItem(REFRESH_EXPIRY_KEY);
}
}else{

localStorage.removeItem(REFRESH_TOKEN_KEY);
localStorage.removeItem(REFRESH_EXPIRY_KEY);
}
}

function renewPokebinAccessToken(rejectedToken){
if(refreshRequest)return refreshRequest;
var generation=authGeneration;
var renew=async function(){
if(generation!==authGeneration)return null;

var accessToken=getPokebinAccessToken();
var expiry=Number(localStorage.getItem(EXPIRY_KEY));
var refreshToken=getPokebinRefreshToken();
if(accessToken&&(rejectedToken?accessToken!==rejectedToken:
!refreshToken||!expiry||expiry>Date.now()+REFRESH_SKEW_MS)){
return accessToken;
}
if(!refreshToken){
if(rejectedToken&&localStorage.getItem(TOKEN_KEY)===rejectedToken)forgetPokebinAuth();
return null;
}
var res=await fetch(POKEBIN_BASE+"/api/oauth/token",{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({
client_id:'showdown-web',grant_type:'refresh_token',refresh_token:refreshToken
})
});
var json=await res.json();
if(generation!==authGeneration||localStorage.getItem(REFRESH_TOKEN_KEY)!==refreshToken){

if(res.ok&&json.refresh_token&&!localStorage.getItem(REFRESH_TOKEN_KEY)){
revokePokebinToken(json.refresh_token);
}
return generation===authGeneration&&getPokebinRefreshToken()?getPokebinAccessToken():null;
}
if(!res.ok){
if(res.status>=400&&res.status<500&&json.error==='invalid_grant'){
forgetPokebinAuth();
return null;
}

throw new Error("PokeBin token refresh failed: "+res.status);
}
if(!json.access_token||!json.expires_in){
throw new Error('PokeBin token refresh returned an invalid response');
}
setPokebinToken(json);
return json.access_token;
};
var locks=typeof navigator!=='undefined'?navigator.locks:undefined;
var request=locks?locks.request('pokebin-refresh',renew):renew();
refreshRequest=request;
void request.then(function(){
if(refreshRequest===request)refreshRequest=null;
},function(){
if(refreshRequest===request)refreshRequest=null;
});
return request;
}

async function connectPokebin(){
var generation=authGeneration;
var verifier=randomString(32);
var challenge=await pkceChallenge(verifier);
if(generation!==authGeneration)return null;
var state=randomString(16);

sessionStorage.setItem('pokebin_verifier',verifier);
sessionStorage.setItem('pokebin_state',state);

var redirectUri=location.origin+"/pokebin-callback";
var params=new URLSearchParams({
client_id:'showdown-web',
redirect_uri:redirectUri,
state:state,
code_challenge:challenge,
code_challenge_method:'S256'
});

var url=POKEBIN_BASE+"/auth/client/start?"+params.toString();
var popup=window.open(url,'pokebin-auth','width=520,height=640');

if(!popup){

location.href=url;
return null;
}

return new Promise(function(resolve){
var done=false;
var timeout=setTimeout(function(){
if(!done){
done=true;
window.removeEventListener('message',handler);
resolve(null);
}
},10*60*1000);

var handler=async function(event){

if(event.origin!==location.origin)return;
var data=event.data;
if(!data||data.type!=='pokebin-auth-callback')return;
if(done)return;
var expectedState=sessionStorage.getItem('pokebin_state');
if(data.state!==expectedState){
console.error('PokeBin auth state mismatch');
return;
}
done=true;
clearTimeout(timeout);
window.removeEventListener('message',handler);

var code=data.code;
var storedVerifier=sessionStorage.getItem('pokebin_verifier');
sessionStorage.removeItem('pokebin_verifier');
sessionStorage.removeItem('pokebin_state');

try{
var res=await fetch(POKEBIN_BASE+"/api/oauth/token",{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({
client_id:'showdown-web',
code:code,
redirect_uri:redirectUri,
code_verifier:storedVerifier
})
});
if(!res.ok){
var txt=await res.text();
console.error('PokeBin token exchange failed',res.status,txt);
resolve(null);
return;
}
var json=await res.json();
if(!json.access_token||!json.expires_in){
console.error('PokeBin token response did not contain an access token',json);
resolve(null);
return;
}
if(generation!==authGeneration){
if(json.refresh_token)revokePokebinToken(json.refresh_token);
resolve(null);
return;
}
setPokebinToken(json);
resolve(json.access_token);
}catch(e){
console.error(e);
resolve(null);
}
};

window.addEventListener('message',handler);


var poll=setInterval(function(){
if(popup.closed&&!done){
done=true;
clearTimeout(timeout);
clearInterval(poll);
window.removeEventListener('message',handler);
resolve(null);
}
if(done)clearInterval(poll);
},500);
});
}

async function uploadPokebinAuthenticated(encodedData){var visibility=arguments.length>1&&arguments[1]!==undefined?arguments[1]:'private';
var token=await renewPokebinAccessToken();
if(!token)return null;
var upload=function(accessToken){return fetch(POKEBIN_BASE+"/api/pastes",{
method:'POST',
headers:{
'Content-Type':'application/json',
'Authorization':"Bearer "+accessToken
},
body:JSON.stringify({data:encodedData,visibility:visibility})
});};
var res=await upload(token);
if(res.status===401){
token=await renewPokebinAccessToken(token);
if(!token)return null;
res=await upload(token);
}
if(!res.ok){
var txt=await res.text();
throw new Error("PokeBin upload failed: "+res.status+" "+txt);
}
var json=await res.json();
return json.uuid;
}





async function authenticatedPokebinFetch(path){
var token=await renewPokebinAccessToken();
if(!token)return null;
var request=function(accessToken){return fetch(""+POKEBIN_BASE+path,{
headers:{Authorization:"Bearer "+accessToken}
});};
var response=await request(token);
if(response.status===401){
token=await renewPokebinAccessToken(token);
if(!token)return null;
response=await request(token);
}
return response;
}

async function getPokebinOwnedPastes(){
var response=await authenticatedPokebinFetch('/api/me/pastes');
if(!response)throw new Error('PokeBin login expired. Reconnect and try again.');
if(!response.ok)throw new Error("PokeBin paste list failed: "+response.status);
var json=await response.json();
return json.pastes;
}

async function getPokebinPaste(uuid){
var response=await authenticatedPokebinFetch("/"+encodeURIComponent(uuid)+"/json");
if(!response)throw new Error('PokeBin login expired. Reconnect and try again.');
if(!response.ok)throw new Error("PokeBin paste could not be loaded: "+response.status);
return response.json();
}
//# sourceMappingURL=pokebin-auth.js.map
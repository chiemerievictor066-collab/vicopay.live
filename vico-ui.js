/* VicoPay Live — shared UI helpers (escape, api, avatars, toast, notification bell) */
(function(){
  // styles live in vico.css; pages that do not load it still get a minimal avatar style
  if(!document.querySelector('link[href*="vico.css"]')){var l=document.createElement("link");l.rel="stylesheet";l.href="vico.css";document.head.appendChild(l);}
  var COLORS=["#0787ed","#7c3aed","#db2777","#ea580c","#059669","#0891b2","#b45309","#4f46e5"];
  var V={
    esc:function(t){var d=document.createElement("div");d.textContent=t==null?"":String(t);return d.innerHTML;},
    api:function(path,opts){opts=opts||{};var o={method:opts.method||"GET",headers:{"Content-Type":"application/json"}};
      if(opts.body!==undefined)o.body=JSON.stringify(opts.body);
      if(location.protocol==="file:")return Promise.resolve({success:false,_ok:false,status:0,message:"Open this page through your VicoPay server (for example http://localhost:3000), not by double-clicking the file."});
      var tries=0;
      function go(){
        return fetch(location.origin+path,o).then(function(r){return r.text().then(function(txt){
          var d;try{d=JSON.parse(txt);}catch(e){
            if(o.method==="GET"&&r.status!==404&&tries++<2)return new Promise(function(res){setTimeout(function(){res(go());},2500);});
            d={success:false,message:r.status===404?"This feature is missing on the server (404). Deploy the newest version.":"The server is starting up or busy. Wait a few seconds and refresh."};
          }
          d._ok=r.ok&&d.success!==false;d.status=r.status;return d;});
        }).catch(function(){return {success:false,_ok:false,status:0,message:"Cannot reach the server. Check your internet connection."};});
      }
      return go();},
    color:function(s){var h=0;s=String(s||"?");for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return COLORS[h%COLORS.length];},
    // Real avatar: initial + stable colour. If the person is live, a red ring links straight into their live.
    // Real picture when the person has uploaded one (url), otherwise their initial on a stable colour.
    // If they are live, a red ring appears and the avatar links straight into their live.
    avatar:function(name,live,roomId,size,url){
      var ch=V.esc(String(name||"?").trim().charAt(0).toUpperCase()||"?"),sz=size?("width:"+size+"px;height:"+size+"px;font-size:"+Math.round(size*.42)+"px;"):"";
      var tag=live&&roomId?"a":"span",href=live&&roomId?' href="live-feed.html?room='+encodeURIComponent(roomId)+'" title="Watch live"':"";
      var img=url?'<img src="'+V.esc(url)+'" alt="" loading="lazy" onerror="this.remove()">':"";
      return "<"+tag+href+' class="va'+(live?" live":"")+'" style="background:'+V.color(name)+";"+sz+'">'+ch+img+(live?'<i class="lv">LIVE</i>':"")+"</"+tag+">";},
    toast:function(t){var e=document.createElement("div");e.className="vtoast";e.textContent=t;document.body.appendChild(e);setTimeout(function(){e.remove();},3000);},
    bottomNav:function(active){
      var items=[["home.html","🏠","Home","home"],["live-room.html","📺","Live","live"],["Go-Live.html","🎥","Go Live","go"],["followers.html","👥","Following","fol"],["profile.html","👤","Me","me"]];
      var n=document.createElement("nav");n.className="v-bottom";
      n.innerHTML=items.map(function(i){return '<a href="'+i[0]+'" class="'+(i[3]==="go"?"go ":"")+(i[3]===active?"on":"")+'"><span'+(i[3]==="me"?' data-my-avatar data-size="26"':'')+'>'+i[1]+'</span>'+i[2]+'</a>';}).join("");
      document.body.appendChild(n);if(V.applyMe)V.applyMe(n);},
    num:function(n){return Number(n||0).toLocaleString();},
    // drop a 🔔 into any element; shows unread count, opens a list, links to live / followers pages
    bell:function(el){
      if(!el||!(window.VicoAuth&&VicoAuth.isSignedIn()))return;
      var b=document.createElement("button");b.className="vbell";b.innerHTML="🔔<b style='display:none'>0</b>";
      var p=document.createElement("div");p.className="vpanel";document.body.appendChild(p);el.appendChild(b);
      function load(){V.api("/api/notifications").then(function(d){if(!d._ok)return;var n=b.querySelector("b");n.textContent=d.unread;n.style.display=d.unread?"inline":"none";
        p.innerHTML=d.notifications.length?d.notifications.map(function(x){return '<a class="'+(x.read?"":"un")+'" href="'+V.esc(x.link||"#")+'">'+V.esc(x.text)+"</a>";}).join(""):"<a>No notifications yet.</a>";});}
      b.onclick=function(){var open=p.style.display==="block";p.style.display=open?"none":"block";if(!open)V.api("/api/notifications/read",{method:"POST",body:{}}).then(function(){b.querySelector("b").style.display="none";});};
      load();setInterval(load,30000);}
  };

  // ===== Signed-in person's REAL profile picture, everywhere =====
  // Any element with  data-my-avatar  (optionally data-size="34" and data-my-name) is filled with the
  // owner's own photo (or their initial if they have not uploaded one yet). Updated after every change.
  var ME_KEY="vicoPayMe";
  V.me=function(){try{return JSON.parse(localStorage.getItem(ME_KEY)||"null");}catch(e){return null;}};
  V.applyMe=function(root){
    var me=V.me();if(!me||!(window.VicoAuth&&VicoAuth.isSignedIn()))return;
    var name=me.displayName||me.handle||"?";
    Array.prototype.forEach.call((root||document).querySelectorAll("[data-my-avatar]"),function(el){
      var size=Number(el.getAttribute("data-size"))||34;
      el.innerHTML=V.avatar(name,false,null,size,me.avatar)+(el.hasAttribute("data-my-name")?'<span class="vme-name" style="margin-left:8px;font-weight:700">'+V.esc(name)+"</span>":"");
      if(el.style.display==="none")el.style.display="inline-flex";
      if(el.hasAttribute("data-my-name")){el.style.alignItems="center";}
      if(el.tagName==="A"&&!el.getAttribute("href"))el.setAttribute("href","profile.html");
      el.title="My profile";
    });
  };
  V.setMe=function(patch){
    var me=Object.assign({},V.me()||{},patch||{});
    try{localStorage.setItem(ME_KEY,JSON.stringify(me));if(me.displayName)localStorage.setItem("vicoPayDisplayName",me.displayName);}catch(e){}
    V.applyMe();return me;
  };
  V.refreshMe=function(){
    if(!(window.VicoAuth&&VicoAuth.isSignedIn()))return Promise.resolve(null);
    return V.api("/api/me").then(function(d){
      if(!d._ok)return null;
      return V.setMe({handle:d.handle,displayName:d.displayName,avatar:d.avatar,bio:d.bio,email:d.email});
    });
  };
  // shrink a chosen photo to a small square JPEG (the server accepts up to 250 KB) and save it as the owner's picture
  V.uploadAvatar=function(file){
    return new Promise(function(resolve,reject){
      if(!file||!/^image\//.test(file.type))return reject(new Error("Please choose a picture (JPG, PNG or WebP)."));
      var fr=new FileReader();
      fr.onerror=function(){reject(new Error("Could not read that picture."));};
      fr.onload=function(){
        var img=new Image();
        img.onerror=function(){reject(new Error("That file is not a valid picture."));};
        img.onload=function(){
          var S=320,c=document.createElement("canvas");c.width=c.height=S;var x=c.getContext("2d");
          var m=Math.min(img.width,img.height),sx=(img.width-m)/2,sy=(img.height-m)/2;
          x.fillStyle="#fff";x.fillRect(0,0,S,S);x.drawImage(img,sx,sy,m,m,0,0,S,S);
          var q=0.85,data=c.toDataURL("image/jpeg",q);
          while(data.length>300000&&q>0.3){q-=0.1;data=c.toDataURL("image/jpeg",q);}
          V.api("/api/profile/avatar",{method:"POST",body:{image:data}}).then(function(d){
            if(!d._ok)return reject(new Error(d.message||"Could not save the picture."));
            V.setMe({avatar:d.avatar});resolve(d.avatar);
          });
        };
        img.src=fr.result;
      };
      fr.readAsDataURL(file);
    });
  };
  function bootMe(){
    if(!(window.VicoAuth&&VicoAuth.isSignedIn()))return;
    V.applyMe();            // instantly from cache
    V.refreshMe();          // then from the server
    // pick up elements added later (bottom nav, menus)
    setTimeout(function(){V.applyMe();},600);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bootMe);else bootMe();
  window.VicoUI=V;
})();

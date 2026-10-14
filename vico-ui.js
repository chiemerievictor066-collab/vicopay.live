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
      n.innerHTML=items.map(function(i){return '<a href="'+i[0]+'" class="'+(i[3]==="go"?"go ":"")+(i[3]===active?"on":"")+'"><span>'+i[1]+'</span>'+i[2]+'</a>';}).join("");
      document.body.appendChild(n);},
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
  window.VicoUI=V;
})();

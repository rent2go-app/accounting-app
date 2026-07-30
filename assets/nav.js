/* Rent 2 Go — shared collapsible sidebar navigation.
   One nav for every admin page. Include with: <script defer src="assets/nav.js"></script>
   Groups the app by job (Money / Billing / Fleet / People / Personal). Role-aware:
   admins see everything; anyone else sees only the Personal items. Self-contained — injects
   its own CSS, shifts page content right on desktop, and is off-canvas (hamburger) on mobile. */
(function () {
  "use strict";
  if (window.__r2gNav) return; window.__r2gNav = true;

  var ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
  // all:true → visible to everyone (personal budgets). Everything else is admin-only.
  var MENU = [
    { g: "Money", icon: "💰", items: [
      { t: "Daily Sheet", h: "index.html", icon: "📒" },
      { t: "Ledger", h: "ledger.html", icon: "📗" },
      { t: "Budget & Projection", h: "budget.html", icon: "📈" },
    ]},
    { g: "Billing — Linda", icon: "🧾", items: [
      { t: "Collections", h: "linda.html", icon: "🤖" },
      { t: "Payment Trends", h: "linda.html#reports", icon: "📊" },
    ]},
    { g: "Fleet", icon: "🚗", items: [
      { t: "Vehicles", h: "cars.html", icon: "🚙" },
      { t: "GPS Tracker", h: "gps.html", icon: "📡" },
      { t: "Fleet (old)", h: "fleet.html", icon: "🗂️" },
    ]},
    { g: "People", icon: "👥", items: [
      { t: "Owners", h: "owners.html", icon: "👤" },
      { t: "Renters & ID", h: "renters.html", icon: "🪪" },
      { t: "Team", h: "team.html", icon: "🧑‍🤝‍🧑" },
    ]},
    { g: "Personal & Tools", icon: "⚙️", items: [
      { t: "My Budget", h: "mybudget.html", icon: "💼", all: true },
      { t: "Home Budget", h: "home.html", icon: "🏠", all: true },
      { t: "Import", h: "import.html", icon: "⬆️" },
    ]},
  ];

  var page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (page === "login.html" || page === "") return; // no nav on the login screen

  var COLLAPSE_KEY = "r2gnav_collapsed";
  var collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";

  var CSS = [
    ":root{--r2gnav-w:230px;--r2gnav-wc:62px}",
    "#r2gnav{position:fixed;top:0;left:0;bottom:0;width:var(--r2gnav-w);background:#0d2b1e;color:#e7f3ec;z-index:9000;display:flex;flex-direction:column;font-family:inherit;box-shadow:2px 0 14px rgba(0,0,0,.18);transition:width .16s ease,transform .2s ease;overflow:hidden}",
    "#r2gnav a{color:inherit;text-decoration:none}",
    "#r2gnav .r2gbrand{display:flex;align-items:center;gap:9px;padding:14px 14px 12px;font-weight:800;letter-spacing:.02em;font-size:15px;white-space:nowrap}",
    "#r2gnav .r2gbrand .dot{width:26px;height:26px;border-radius:7px;background:#18c06a;display:grid;place-items:center;color:#062;flex:none;font-size:14px}",
    "#r2gnav .r2gscroll{flex:1;overflow-y:auto;padding:4px 0 12px}",
    "#r2gnav .r2ggrp{margin:2px 0}",
    "#r2gnav .r2ggl{display:flex;align-items:center;gap:9px;padding:9px 15px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#7fb79a;white-space:nowrap}",
    "#r2gnav .r2gi{display:flex;align-items:center;gap:11px;padding:8px 15px;font-size:14px;white-space:nowrap;border-left:3px solid transparent}",
    "#r2gnav .r2gi:hover{background:rgba(255,255,255,.06)}",
    "#r2gnav .r2gi.on{background:rgba(24,192,106,.16);border-left-color:#18c06a;font-weight:700}",
    "#r2gnav .r2gi .ic{width:20px;text-align:center;flex:none;font-size:15px}",
    "#r2gnav .r2gfoot{border-top:1px solid rgba(255,255,255,.1);padding:8px}",
    "#r2gnav .r2gfoot button{width:100%;background:transparent;color:#cfe6d9;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:8px;cursor:pointer;font:inherit;font-size:13px}",
    "#r2gnav .r2gfoot button:hover{background:rgba(255,255,255,.08)}",
    "#r2gnav .r2gwho{font-size:11px;color:#7fb79a;padding:4px 6px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#r2gcollapse{position:absolute;top:12px;right:8px;background:transparent;border:0;color:#9ccbb4;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:6px}",
    "#r2gcollapse:hover{background:rgba(255,255,255,.1)}",
    // collapsed (desktop icons-only)
    "body.r2gnav-collapsed #r2gnav{width:var(--r2gnav-wc)}",
    "body.r2gnav-collapsed #r2gnav .r2gbrand span,body.r2gnav-collapsed #r2gnav .r2gi .tx,body.r2gnav-collapsed #r2gnav .r2ggl span,body.r2gnav-collapsed #r2gnav .r2gwho,body.r2gnav-collapsed #r2gnav .r2gfoot button .tx{display:none}",
    "body.r2gnav-collapsed #r2gnav .r2ggl{justify-content:center;padding-left:0;padding-right:0}",
    "body.r2gnav-collapsed #r2gnav .r2gi{justify-content:center;padding-left:0;padding-right:0;gap:0}",
    // shift page content on desktop
    "@media(min-width:900px){body{padding-left:var(--r2gnav-w)!important;transition:padding-left .16s ease}body.r2gnav-collapsed{padding-left:var(--r2gnav-wc)!important}#r2gburger,#r2gback{display:none!important}}",
    // mobile: off-canvas
    "@media(max-width:899px){#r2gnav{transform:translateX(-100%)}body.r2gnav-open #r2gnav{transform:translateX(0)}",
    "#r2gburger{position:fixed;top:10px;left:10px;z-index:9001;background:#0d2b1e;color:#fff;border:0;border-radius:9px;width:42px;height:42px;font-size:19px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.25)}",
    "#r2gback{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:8999;display:none}body.r2gnav-open #r2gback{display:block}}",
  ].join("");

  function build() {
    if (document.getElementById("r2gnav")) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);

    var groups = MENU.map(function (grp) {
      var items = grp.items.map(function (it) {
        var on = it.h.split("#")[0] === page ? " on" : "";
        return '<a class="r2gi' + on + '" href="' + it.h + '" data-admin="' + (it.all ? "0" : "1") + '"><span class="ic">' + it.icon + '</span><span class="tx">' + it.t + '</span></a>';
      }).join("");
      return '<div class="r2ggrp" data-admin="' + (grp.items.every(function (i) { return i.all; }) ? "0" : "1") + '"><div class="r2ggl"><span class="gic">' + grp.icon + '</span><span>' + grp.g + '</span></div>' + items + "</div>";
    }).join("");

    var aside = document.createElement("aside");
    aside.id = "r2gnav";
    aside.innerHTML =
      '<div class="r2gbrand"><span class="dot">R</span><span>RENT 2 GO</span></div>' +
      '<button id="r2gcollapse" title="Collapse / expand">⟨⟩</button>' +
      '<div class="r2gscroll">' + groups + "</div>" +
      '<div class="r2gfoot"><div class="r2gwho" id="r2gwho"></div><button id="r2gout"><span class="tx">Sign out</span><span aria-hidden="true"> ⎋</span></button></div>';

    var burger = document.createElement("button"); burger.id = "r2gburger"; burger.setAttribute("aria-label", "Menu"); burger.textContent = "☰";
    var back = document.createElement("div"); back.id = "r2gback";
    document.body.appendChild(aside); document.body.appendChild(burger); document.body.appendChild(back);
    if (collapsed) document.body.classList.add("r2gnav-collapsed");

    document.getElementById("r2gcollapse").onclick = function () {
      collapsed = !document.body.classList.contains("r2gnav-collapsed");
      document.body.classList.toggle("r2gnav-collapsed", collapsed);
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    };
    burger.onclick = function () { document.body.classList.toggle("r2gnav-open"); };
    back.onclick = function () { document.body.classList.remove("r2gnav-open"); };

    // role + sign out (own client so it works regardless of the page's script)
    try {
      if (window.supabase && window.R2G_CONFIG) {
        var sb = window.supabase.createClient(window.R2G_CONFIG.SUPABASE_URL, window.R2G_CONFIG.SUPABASE_ANON_KEY);
        document.getElementById("r2gout").onclick = function () { sb.auth.signOut().then(function () { location.href = "login.html"; }); };
        sb.auth.getSession().then(function (r) {
          var email = r && r.data && r.data.session && r.data.session.user ? (r.data.session.user.email || "") : "";
          var isAdmin = ADMINS.indexOf(email.toLowerCase()) >= 0;
          var who = document.getElementById("r2gwho"); if (who) who.textContent = email || "";
          if (!isAdmin) {
            // hide admin-only groups + items for non-admins
            aside.querySelectorAll('[data-admin="1"]').forEach(function (el) { el.style.display = "none"; });
          }
        });
      } else {
        document.getElementById("r2gout").onclick = function () { location.href = "login.html"; };
      }
    } catch (e) { /* nav must never break the page */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();

// Schreibt ein fertiges Avis in die Testdatenbank.
// Greift nur, wenn die Konvertierung fehlerfrei war (result.ready).
// Beruehrt die Produktivdatenbank nicht.
//
// WEG: Neon bietet SQL ueber HTTPS an, deshalb laeuft alles ueber UrlFetchApp.
// Der JDBC-Dienst von Apps Script scheidet aus: er kennt fuer fremde Datenbanken
// nur eine feste Liste erlaubter Eigenschaften (user, password, databaseName,
// useJDBCCompliantTimeZoneShift und drei Zertifikatsfelder). "ssl" oder "sslmode"
// gehoeren nicht dazu und werden abgelehnt, ohne sie kommt aber keine
// verschluesselte Verbindung zustande -- und Neon laesst nur verschluesselte zu.
//
// Erwartete Skripteigenschaften:
//   DB_HOST, DB_NAME, DB_USER, DB_PASS
//   AVIS_INSTANCE_KEY            Mandantenschluessel (Smilodox = 1)
//   AVIS_STATUS                  Statuszahl fuer ein neu angelegtes Avis (8 = "Bestellung avisiert")
// Optional je Lieferant:
//   AVIS_SUPPLIER_LIEFERANT_I       Lieferantennummer Lieferant I (690381)
//   AVIS_SUPPLIER_LIEFERANT_J Lieferantennummer Lieferant J (im Portal noch nicht angelegt)
const AVIS_DB_KERN_SCHLUESSEL = ['DB_HOST','DB_NAME','DB_USER','DB_PASS','AVIS_INSTANCE_KEY','AVIS_STATUS'];
const AVIS_DB_LIEFERANTEN_SCHLUESSEL = {Lieferant J:'AVIS_SUPPLIER_LIEFERANT_J',Lieferant I:'AVIS_SUPPLIER_LIEFERANT_I'};

function avisDbKonfig_(){
  const props=PropertiesService.getScriptProperties();
  const fehlend=AVIS_DB_KERN_SCHLUESSEL.filter(k=>!props.getProperty(k));
  if(fehlend.length)return {bereit:false,fehlend};
  const zahl=(k)=>{
    const v=Number(props.getProperty(k));
    if(!Number.isInteger(v))throw Error('Skripteigenschaft '+k+' muss eine ganze Zahl sein.');
    return v;
  };
  const host=String(props.getProperty('DB_HOST')).trim();
  // Haeufigster Einrichtungsfehler: die Adresse wurde beim Einfuegen abgeschnitten.
  // Das faellt sonst erst als unverstaendlicher DNS-Fehler auf.
  if(!/^[a-z0-9.\-]+\.[a-z]{2,}$/i.test(host)||host.indexOf('.')<0){
    throw Error('DB_HOST sieht unvollstaendig aus: "'+host+'". '
              + 'Erwartet wird die vollstaendige Adresse, z. B. '
              + 'ep-xxxx.c-6.eu-central-1.aws.neon.tech');
  }
  const lieferanten={};
  Object.keys(AVIS_DB_LIEFERANTEN_SCHLUESSEL).forEach(function(name){
    const wert=props.getProperty(AVIS_DB_LIEFERANTEN_SCHLUESSEL[name]);
    if(wert!=null&&wert!=='')lieferanten[name]=zahl(AVIS_DB_LIEFERANTEN_SCHLUESSEL[name]);
  });
  return {
    bereit:true,
    url:'https://'+host+'/sql',
    verbindung:'postgresql://'+encodeURIComponent(props.getProperty('DB_USER'))
              +':'+encodeURIComponent(props.getProperty('DB_PASS'))
              +'@'+host+'/'+props.getProperty('DB_NAME')+'?sslmode=require',
    instanceKey:props.getProperty('AVIS_INSTANCE_KEY'),
    status:zahl('AVIS_STATUS'),
    lieferanten
  };
}

// Fuehrt eine SQL-Anweisung aus und gibt die Ergebniszeilen zurueck.
// Werte gehoeren immer in params, nie in den SQL-Text - das schuetzt vor
// Einschleusung und uebernimmt die Typumwandlung.
function avisDbAbfrage_(konfig,sql,params){
  const antwort=UrlFetchApp.fetch(konfig.url,{
    method:'post',
    contentType:'application/json',
    headers:{'Neon-Connection-String':konfig.verbindung},
    payload:JSON.stringify({query:sql,params:params||[]}),
    muteHttpExceptions:true
  });
  const code=antwort.getResponseCode(), text=antwort.getContentText();
  if(code!==200){
    let hinweis=text;
    try{const j=JSON.parse(text);if(j.message)hinweis=j.message;}catch(ignored){}
    throw Error('Datenbank antwortete mit HTTP '+code+': '+String(hinweis).slice(0,300));
  }
  return JSON.parse(text).rows||[];
}

// Eindeutige Kennung einer Packliste. Dieselbe Datei desselben Lieferanten
// ergibt dieselbe Kennung, damit ein zweiter Lauf kein zweites Avis anlegt.
function avisDbReferenz_(supplier,hash){
  return supplier+'|'+String(hash).slice(0,16);
}

// Liefertermin aus dem Dateinamen, Format TT.MM.JJJJ. Ohne Fund: null.
function avisDbLieferdatum_(dateiname){
  const m=String(dateiname).match(/(\d{2})[. _-](\d{2})[. _-](\d{4})/);
  return m?m[3]+'-'+m[2]+'-'+m[1]+' 00:00:00':null;
}

// Kopf und Positionen entstehen in EINER Anweisung. Damit ist der Vorgang
// unteilbar: entweder steht alles oder nichts, ohne eigene Transaktionsklammer.
// Das WHERE NOT EXISTS verhindert ein zweites Avis zur selben Packliste.
// Das GROUP BY addiert gleiche EAN, weil pro Avis nur eine Zeile je EAN
// ohne Charge erlaubt ist.
const AVIS_DB_SCHREIBEN_SQL =
  'WITH neu AS ('
+ '  INSERT INTO logistics.purchase_orders'
+ '    (instance_key, supplier_id, status, planned_delivery_date, supplier_name, reference)'
+ '  SELECT $1::varchar, $2::int, $3::numeric, $4::timestamp, $5::varchar, $6::varchar'
+ '  WHERE NOT EXISTS (SELECT 1 FROM logistics.purchase_orders WHERE reference = $6::varchar)'
+ '  RETURNING id'
+ '), pos AS ('
+ '  INSERT INTO logistics.purchase_order_items (purchase_order_id, ean, quantity)'
+ '  SELECT neu.id, p.ean, sum(p.menge)::int'
+ '  FROM neu, jsonb_to_recordset($7::jsonb) AS p(ean varchar, menge int)'
+ '  GROUP BY neu.id, p.ean'
+ '  RETURNING quantity'
+ ') SELECT (SELECT id FROM neu) AS avis_id,'
+ '         (SELECT count(*) FROM pos) AS positionen,'
+ '         (SELECT coalesce(sum(quantity),0) FROM pos) AS stueck';

// Rueckgabe: {geschrieben:true, avisId, positionen, stueck, referenz}
//        oder {geschrieben:false, grund, avisId?}
function avisDbSchreiben_(result,source,supplier){
  const konfig=avisDbKonfig_();
  if(!konfig.bereit)return {geschrieben:false,grund:'Skripteigenschaften fehlen: '+konfig.fehlend.join(', ')};
  if(!result.ready)return {geschrieben:false,grund:'CSV unvollstaendig; es wird nichts geschrieben.'};
  if(!result.rows||!result.rows.length)return {geschrieben:false,grund:'Keine Positionen.'};
  const supplierId=konfig.lieferanten[supplier];
  if(supplierId==null)return {geschrieben:false,grund:'Lieferantennummer fuer '+supplier+' ist nicht hinterlegt.'};

  const referenz=avisDbReferenz_(supplier,source.hash);
  // result.rows: [EAN, Variantennummer, Beschreibung, Menge]
  const positionen=result.rows.map(function(z){return {ean:String(z[0]),menge:Number(z[3])};});
  const erwartetStueck=positionen.reduce(function(a,p){return a+p.menge;},0);

  const zeilen=avisDbAbfrage_(konfig,AVIS_DB_SCHREIBEN_SQL,[
    konfig.instanceKey, supplierId, konfig.status,
    avisDbLieferdatum_(source.attachment), supplier, referenz,
    JSON.stringify(positionen)
  ]);
  const z=zeilen[0]||{};
  if(z.avis_id==null){
    const vorhanden=avisDbAbfrage_(konfig,
      'SELECT id FROM logistics.purchase_orders WHERE reference = $1::varchar',[referenz]);
    return {geschrieben:false,grund:'Avis existiert bereits',avisId:vorhanden.length?vorhanden[0].id:null};
  }

  // Gegenprobe: was in der Datenbank steht, muss der CSV entsprechen.
  const geschriebenePos=Number(z.positionen), geschriebeneStueck=Number(z.stueck);
  if(geschriebenePos!==positionen.length||geschriebeneStueck!==erwartetStueck){
    avisDbAbfrage_(konfig,'DELETE FROM logistics.purchase_orders WHERE id = $1::int',[z.avis_id]);
    throw Error('Gegenprobe fehlgeschlagen, Avis wurde zurueckgenommen: Datenbank '
               +geschriebenePos+'/'+geschriebeneStueck+', erwartet '+positionen.length+'/'+erwartetStueck);
  }
  return {geschrieben:true,avisId:z.avis_id,positionen:geschriebenePos,stueck:geschriebeneStueck,referenz};
}

// Einmaliger Verbindungstest. Schreibt nichts.
function avisDbVerbindungTesten(){
  const konfig=avisDbKonfig_();
  if(!konfig.bereit){console.warn('Es fehlen noch Skripteigenschaften: '+konfig.fehlend.join(', '));return;}
  const zeilen=avisDbAbfrage_(konfig,
    'SELECT version() AS v, (SELECT count(*) FROM logistics.purchase_orders) AS avise',[]);
  console.log('Verbindung steht.');
  console.log(zeilen[0].v);
  console.log('Avise in der Testdatenbank: '+zeilen[0].avise);
}

// Zeigt an, was gesetzt ist und was fehlt. Schreibt nichts.
function avisDbKonfigPruefen(){
  const konfig=avisDbKonfig_();
  if(!konfig.bereit){console.warn('Es fehlen noch Kern-Skripteigenschaften: '+konfig.fehlend.join(', '));return;}
  console.log('Datenbank-Zugang und Kernwerte sind gesetzt.');
  const bekannt=Object.keys(konfig.lieferanten);
  console.log('Lieferanten mit hinterlegter Nummer: '+(bekannt.length?bekannt.join(', '):'keiner'));
  Object.keys(AVIS_DB_LIEFERANTEN_SCHLUESSEL).filter(n=>!bekannt.includes(n)).forEach(function(n){
    console.log('  Noch offen: '+n+' (Skripteigenschaft '+AVIS_DB_LIEFERANTEN_SCHLUESSEL[n]+')');
  });
}

// Zeigt die zuletzt geschriebenen Avise, aufgemacht wie die Portal-Ansicht.
// Schreibt nichts.
function avisDbUebersicht(){
  const konfig=avisDbKonfig_();
  if(!konfig.bereit){console.warn('Es fehlen noch Skripteigenschaften: '+konfig.fehlend.join(', '));return;}
  const zeilen=avisDbAbfrage_(konfig,
    'SELECT o.id, o.instance_key, o.supplier_id, o.supplier_name, o.status, o.reference,'
  + '       to_char(o.planned_delivery_date,\'DD.MM.YY\') AS datum,'
  + '       count(i.id) AS positionen, coalesce(sum(i.quantity),0) AS stueck'
  + ' FROM logistics.purchase_orders o'
  + ' LEFT JOIN logistics.purchase_order_items i ON i.purchase_order_id = o.id'
  + ' GROUP BY o.id ORDER BY o.id DESC LIMIT 20',[]);
  if(!zeilen.length){console.log('Noch keine Avise in der Testdatenbank.');return;}
  console.log('Id | Mandant | Lieferant | Status | Referenz | Anlieferung | Positionen | Stueck');
  zeilen.forEach(function(r){
    console.log([r.id,r.instance_key,(r.supplier_name||r.supplier_id),r.status,r.reference,
                 r.datum||'-',r.positionen,r.stueck].join(' | '));
  });
}

// Zeigt die hinterlegten Einstellungen zur Kontrolle. Das Passwort bleibt verborgen.
function avisDbEinstellungenZeigen(){
  const props=PropertiesService.getScriptProperties();
  ['DB_HOST','DB_NAME','DB_USER','AVIS_INSTANCE_KEY','AVIS_STATUS',
   'AVIS_SUPPLIER_LIEFERANT_I','AVIS_SUPPLIER_LIEFERANT_J'].forEach(function(k){
    const v=props.getProperty(k);
    console.log(k+' = '+(v==null?'(nicht gesetzt)':'"'+v+'"  ['+String(v).length+' Zeichen]'));
  });
  const pass=props.getProperty('DB_PASS');
  console.log('DB_PASS = '+(pass?'gesetzt ['+pass.length+' Zeichen]':'(nicht gesetzt)'));
}

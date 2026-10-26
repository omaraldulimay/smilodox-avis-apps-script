// Diagnose der offenen Zuordnungen. Liest ausschliesslich.
// Erzeugt keine CSV, schreibt kein Protokoll, schreibt nichts in die Datenbank.
// Zweck: zeigen, WARUM eine Packlistenzeile nicht zugeordnet werden konnte,
// indem daneben steht, welche Farben und Groessen es zu dem Artikel im Stock gibt.

// Bewusste Kopie der Normalisierung aus lieferantCsvKonvertieren_.
// Getrennt gehalten, damit eine Aenderung hier die Produktivlogik nicht beeinflusst.
function avisDiagNorm_(x){return String(x??'').trim().replace(/\s+/g,' ').toLowerCase();}
function avisDiagArtikel_(x){return avisDiagNorm_(x).replace(/_/g,'-');}
function avisDiagFarbe_(x){
  const n=avisDiagNorm_(x).replace(/\s*\/\s*/g,'/');
  const aliases={'yellow':'gelb','white':'weiß','grey melange':'grau melange','dunkelgrun':'dunkelgrün','dunkel grün':'dunkelgrün','black':'schwarz','anthrasit':'anthrazit','anthrasit black':'anthrazit/schwarz','grun black':'grün/schwarz','black anthrasit':'schwarz/anthrazit','black yellow':'schwarz/gelb','marinablau':'marineblau','marinablue':'marineblau','royal blua':'royal blau','acidblack':'acid schwarz','grun':'grün','dunkelblue':'dunkelblau','dunkel blau':'dunkelblau','dunkel rot':'dunkelrot'};
  return aliases[n]||n;
}
function avisDiagGroesse_(x){return avisDiagNorm_(x)==='2xl'?'xxl':avisDiagNorm_(x);}

// Hauptfunktion. Ohne Argument: die Lieferant J-Beispielmail.
// Mit Argument: ein Eintrag aus der bestehenden Fuenfer-Auswahl.
function diagnoseZuordnung(batchSource){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const temporary=[];
  try{
    const stockBook=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
    const source=batchSource?lieferantBatchQuelle_(batchSource,temporary):lieferantCsvQuelle_(temporary);

    // Stock einlesen, gleiche Spaltenlogik wie im Produktivlauf.
    const stockAliases={'Var.number':['Var.number','Var_number'],Attribut:['Attribut'],EAN13:['EAN13']};
    const stockSheets=stockBook.getSheets().filter(s=>{
      if(!s.getLastRow()||!s.getLastColumn())return false;
      const headers=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
      return Object.values(stockAliases).every(names=>names.some(n=>headers.includes(n)));
    });
    if(stockSheets.length!==1)throw Error('Stock-Blatt nicht eindeutig gefunden.');
    const sheet=stockSheets[0],headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
    const columns={};
    Object.keys(stockAliases).forEach(h=>{
      const matches=headers.map((name,i)=>stockAliases[h].includes(name)?i:-1).filter(i=>i>=0);
      if(matches.length!==1)throw Error('Stock-Spalte fehlt oder ist doppelt: '+h);
      columns[h]=sheet.getRange(2,matches[0]+1,sheet.getLastRow()-1,1).getDisplayValues();
    });
    const stock=columns['Var.number'].map((_,i)=>Object.fromEntries(Object.keys(columns).map(h=>[h,columns[h][i][0]])));
    console.log('Stock-Zeilen gelesen: '+stock.length);

    // Zwei Verzeichnisse:
    //   alleArtikel  – JEDE Stock-Zeile, auch ohne Color/Size. Beantwortet: existiert der Artikel ueberhaupt?
    //   jeArtikel    – nur zuordnungsfaehige Zeilen, wie im Produktivlauf.
    const index=new Map(), jeArtikel=new Map(), alleArtikel=new Map();
    for(const row of stock){
      const variant=String(row['Var.number']||'').trim();
      if(!variant)continue;
      const base=variant.replace(/-[A-Za-z]+\d+$/,'');
      const a=avisDiagArtikel_(base);
      if(!alleArtikel.has(a))alleArtikel.set(a,{roh:base,zeilen:0,mitAttribut:0,beispiele:[]});
      const eintrag=alleArtikel.get(a);
      eintrag.zeilen++;
      if(eintrag.beispiele.length<3)eintrag.beispiele.push(variant+' ['+String(row.Attribut||'(kein Attribut)')+']');
      const attrs=Object.fromEntries(String(row.Attribut||'').split(/[;,]/).filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return [x.slice(0,i).trim(),x.slice(i+1).trim()];}));
      if(!attrs.Color||!attrs.Size)continue;
      eintrag.mitAttribut++;
      const k=JSON.stringify([a,avisDiagFarbe_(attrs.Color),avisDiagGroesse_(attrs.Size)]);
      if(!index.has(k))index.set(k,[]);
      index.get(k).push(variant);
      if(!jeArtikel.has(a))jeArtikel.set(a,{farben:new Set(),groessen:new Set()});
      jeArtikel.get(a).farben.add(avisDiagFarbe_(attrs.Color));
      jeArtikel.get(a).groessen.add(avisDiagGroesse_(attrs.Size));
    }
    console.log('Artikel im Stock gesamt: '+alleArtikel.size+', davon zuordnungsfaehig: '+jeArtikel.size);

    // Packliste lesen.
    const candidates=source.book.getSheets().filter(s=>s.getRange(1,1,Math.min(20,s.getLastRow()),s.getLastColumn()).getDisplayValues().some(r=>r.includes('ART. NO')&&r.includes('SENT PCS.')));
    if(candidates.length!==1)throw Error('Packlisten-Blatt nicht eindeutig gefunden.');
    const packing=candidates[0].getDataRange().getValues();
    const header=packing.findIndex(r=>r.includes('ART. NO')&&r.includes('SENT PCS.'));
    const h=packing[header];
    const a=h.indexOf('ART. NO'),c=h.indexOf('COLOUR'),s=h.indexOf('SIZE'),q=h.indexOf('SENT PCS.');

    const offene=[];
    packing.slice(header+1).forEach((row,offset)=>{
      if(!row[a]&&!row[c]&&!row[s])return;
      if(!row[a]||!row[c]||!row[s])return;
      if(avisDiagNorm_(row[s])==='mix')return;
      const artikel=avisDiagArtikel_(row[a]),farbe=avisDiagFarbe_(row[c]),groesse=avisDiagGroesse_(row[s]);
      const treffer=index.get(JSON.stringify([artikel,farbe,groesse]))||[];
      if(treffer.length===1)return;
      offene.push({zeile:header+offset+2,artikel,farbe,groesse,menge:Number(row[q])||0,
                   rohArtikel:String(row[a]),rohFarbe:String(row[c]),rohGroesse:String(row[s]),treffer:treffer.length});
    });

    console.log('=== Offene Zeilen: '+offene.length+' ===');
    offene.forEach(o=>{
      const vorhanden=jeArtikel.get(o.artikel);
      if(!vorhanden){
        console.log('Zeile '+o.zeile+' | Packliste "'+o.rohArtikel+'" -> gedeutet als "'+o.artikel
                   +'" | Menge '+o.menge+' | Artikel nicht zuordnungsfaehig (Urteil siehe unten).');
        return;
      }
      const farbeDa=vorhanden.farben.has(o.farbe), groesseDa=vorhanden.groessen.has(o.groesse);
      let urteil;
      if(o.treffer>1)urteil='MEHRDEUTIG: '+o.treffer+' Varianten passen.';
      else if(!farbeDa)urteil='FARBE unbekannt. Im Stock zu diesem Artikel: '+[...vorhanden.farben].sort().join(' | ');
      else if(!groesseDa)urteil='GROESSE unbekannt. Im Stock zu diesem Artikel: '+[...vorhanden.groessen].sort().join(' | ');
      else urteil='Farbe und Groesse existieren einzeln, aber nicht in dieser Kombination.';
      console.log('Zeile '+o.zeile+' | '+o.artikel+' | Packliste "'+o.rohFarbe+'" / "'+o.rohGroesse
                 +'" -> gedeutet als "'+o.farbe+'" / "'+o.groesse+'" | Menge '+o.menge+' | '+urteil);
    });

    // Urteil je nicht zuordnungsfaehigem Artikel. Unterscheidet ausdruecklich
    // zwischen "fehlt wirklich" und "existiert, aber die Zuordnung scheitert".
    const betroffen=new Map();
    offene.filter(o=>!jeArtikel.get(o.artikel)).forEach(o=>{
      if(!betroffen.has(o.artikel))betroffen.set(o.artikel,{roh:o.rohArtikel,menge:0,zeilen:0});
      const e=betroffen.get(o.artikel); e.menge+=o.menge; e.zeilen++;
    });
    if(betroffen.size){
      let gesamt=0; betroffen.forEach(e=>{gesamt+=e.menge;});
      console.log('=== Nicht zuordnungsfaehige Artikel: '+betroffen.size+', zusammen '+gesamt+' Stueck ===');
      betroffen.forEach((e,artikel)=>{
        console.log('');
        console.log('ARTIKEL "'+e.roh+'"  ('+e.zeilen+' Zeilen, '+e.menge+' Stueck)');
        const vorhanden=alleArtikel.get(artikel);
        if(vorhanden){
          console.log('  URTEIL: Artikel EXISTIERT im Stock ('+vorhanden.zeilen+' Zeilen), aber keine davon');
          console.log('          hat Color und Size gesetzt. Es fehlt die Pflege der Attribute,');
          console.log('          nicht der Artikel selbst.');
          vorhanden.beispiele.forEach(b=>console.log('          Beispiel: '+b));
          return;
        }
        const aehnlich=avisDiagAehnlich_(artikel,alleArtikel);
        if(!aehnlich.length){
          console.log('  URTEIL: Artikel FEHLT wirklich. Keine einzige aehnliche Variantennummer');
          console.log('          unter '+alleArtikel.size+' Artikeln im Stock. Der Artikel muss in den');
          console.log('          Stammdaten angelegt werden, bevor er avisiert werden kann.');
          return;
        }
        console.log('  URTEIL: VORSICHT – aehnliche Nummern im Stock gefunden. Moeglicherweise eine');
        console.log('          abweichende Schreibweise und kein fehlender Artikel. Bitte pruefen:');
        aehnlich.slice(0,15).forEach(t=>console.log('          "'+t.artikel+'"  ('+t.grund+')'));
        if(aehnlich.length>15)console.log('          ... '+(aehnlich.length-15)+' weitere.');
      });
    }

    // Sammelbild: welche Packlisten-Farbschreibweisen scheitern am haeufigsten.
    const proFarbe={};
    offene.forEach(o=>{proFarbe[o.rohFarbe]=(proFarbe[o.rohFarbe]||0)+1;});
    const sortiert=Object.keys(proFarbe).sort((x,y)=>proFarbe[y]-proFarbe[x]);
    if(sortiert.length){
      console.log('=== Haeufigste Farbschreibweisen unter den offenen Zeilen ===');
      sortiert.forEach(f=>console.log('  '+proFarbe[f]+'x  "'+f+'"  -> gedeutet als "'+avisDiagFarbe_(f)+'"'));
    }
    return offene.length;
  }finally{
    for(const id of temporary){
      try{Drive.Files.update({trashed:true},id,null,{supportsAllDrives:true});}
      catch(e){console.log('Temporaere Testkopie blieb liegen: '+id+' – '+e.message);}
    }
  }
}

// Diagnose fuer einen Eintrag aus der bestehenden Fuenfer-Auswahl, z. B. diagnoseAusAuswahl(0).
function diagnoseAusAuswahl(position){
  const queue=JSON.parse(PropertiesService.getUserProperties().getProperty('avis-five-packlists-v1')||'[]');
  if(!queue.length)throw Error('Keine Fuenfer-Auswahl vorhanden.');
  const item=queue[Number(position)||0];
  if(!item)throw Error('Position nicht vorhanden. Verfuegbar: 0 bis '+(queue.length-1));
  console.log('Diagnose: '+item.supplier+' | '+item.name);
  return diagnoseZuordnung(item);
}

// Sucht Variantennummern im Stock, die den Text enthalten. Liest nur.
// Beispiel: artikelSuchen("tsctw")
function artikelSuchen(text){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const suche=String(text||'').trim().toLowerCase();
  if(suche.length<2)throw Error('artikelSuchen braucht einen Suchtext und laesst sich nicht ueber den Ausfuehren-Knopf starten. Nutze diagnoseZuordnung() – sie sucht automatisch nach aehnlichen Nummern.');
  const book=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
  const aliases={'Var.number':['Var.number','Var_number'],Attribut:['Attribut'],EAN13:['EAN13']};
  const sheet=book.getSheets().filter(s=>{
    if(!s.getLastRow()||!s.getLastColumn())return false;
    const hd=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
    return Object.values(aliases).every(names=>names.some(n=>hd.includes(n)));
  })[0];
  if(!sheet)throw Error('Stock-Blatt nicht gefunden.');
  const hd=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
  const spalte=n=>{const i=hd.findIndex(x=>aliases[n].includes(x));if(i<0)throw Error('Spalte fehlt: '+n);return i+1;};
  const anzahl=sheet.getLastRow()-1;
  const nummern=sheet.getRange(2,spalte('Var.number'),anzahl,1).getDisplayValues();
  const attribute=sheet.getRange(2,spalte('Attribut'),anzahl,1).getDisplayValues();
  const eans=sheet.getRange(2,spalte('EAN13'),anzahl,1).getDisplayValues();
  const treffer=[];
  for(let i=0;i<anzahl;i++){
    const nr=String(nummern[i][0]||'');
    if(nr.toLowerCase().includes(suche))treffer.push([nr,String(attribute[i][0]||''),String(eans[i][0]||'')]);
  }
  console.log('Suche "'+suche+'" in '+anzahl+' Stock-Zeilen: '+treffer.length+' Treffer.');
  treffer.slice(0,80).forEach(t=>console.log('  '+t[0]+'  |  '+t[1]+'  |  '+t[2]));
  if(treffer.length>80)console.log('  ... '+(treffer.length-80)+' weitere nicht angezeigt.');
  return treffer.length;
}

// Sucht Variantennummern, die dem gesuchten Artikel aehneln.
// Trennzeichen und Schreibweise werden ignoriert, damit "tsctw26_2" und
// "TSCTW26-2" als dasselbe erkannt werden.
function avisDiagAehnlich_(gesucht,alleArtikel){
  const nur=x=>String(x).toLowerCase().replace(/[^a-z0-9]/g,'');
  const g=nur(gesucht);
  if(g.length<3)return [];
  const treffer=[];
  alleArtikel.forEach((info,artikel)=>{
    const s=nur(artikel);
    if(!s)return;
    if(s===g){treffer.push({artikel:info.roh,grund:'identisch bis auf Trenn- und Grossschreibung',rang:1});return;}
    if(s.includes(g)||g.includes(s)){treffer.push({artikel:info.roh,grund:'eine Nummer steckt in der anderen',rang:2});return;}
    let i=0;
    while(i<Math.min(s.length,g.length)&&s[i]===g[i])i++;
    if(i>=5&&i>=g.length-2)treffer.push({artikel:info.roh,grund:'stimmt in den ersten '+i+' Zeichen ueberein',rang:3});
  });
  treffer.sort((a,b)=>a.rang-b.rang||String(a.artikel).localeCompare(String(b.artikel)));
  return treffer;
}

// Sucht gezielt die neueste Lieferant I-Packliste (letzte 90 Tage) und verarbeitet
// sie genau wie ein automatischer Lauf: CSV erzeugen, protokollieren, und bei
// fehlerfreier Zuordnung ein echtes Avis in die Testdatenbank schreiben.
function testNaechsteLieferantIPackliste(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const allowed=['kontakt@lieferant-i.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example'];
  const ausgeschlossen=['1a000956ace6cc13','1a086a79f397c1e5']; // bekannte Ausreisser, wie in avisFuenfIntern_
  const normal=x=>String(x).normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase();
  const found=[],seen=new Set();
  const cutoff=Date.now()-90*86400000;
  const query='{'+allowed.map(a=>'from:'+a).join(' ')+'} newer_than:90d has:attachment -in:trash -in:spam';
  for(let page=0;page<200;page+=50){
    const threads=GmailApp.search(query,page,50);
    for(const thread of threads)for(const m of thread.getMessages()){
      if(seen.has(m.getId()))continue;seen.add(m.getId());
      const match=m.getFrom().match(/<([^>]+)>/),sender=(match?match[1]:m.getFrom()).trim().toLowerCase();
      if(!allowed.includes(sender)||m.getDate().getTime()<cutoff)continue;
      if(ausgeschlossen.includes(m.getId()))continue;
      for(const a of m.getAttachments({includeInlineImages:false,includeAttachments:true})){
        const n=normal(a.getName());
        if(!/\.xlsx$/.test(n)||!/pack/.test(n)||/invoice|rechnung/.test(n))continue;
        const hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,a.getBytes()).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
        found.push({id:m.getId(),name:a.getName(),hash,date:m.getDate().getTime(),supplier:'Lieferant I',subject:m.getSubject()});
      }
    }
    if(threads.length<50)break;
  }
  if(!found.length)throw Error('Keine passende Lieferant I-Packliste in den letzten 90 Tagen gefunden.');
  found.sort((a,b)=>b.date-a.date);
  const item=found[0];
  console.log('Teste: '+item.supplier+' | '+item.name+' | '+item.subject+' | '+new Date(item.date));
  testLieferantAvisCsv(item);
}

// Durchsucht das Postfach nach Packlisten-artigen Anhaengen ALLER Absender.
// Reine Bestandsaufnahme: liest nur, verarbeitet nichts, erzeugt keine CSV.
// Zweck: zeigen, bei welchen weiteren Lieferanten sich eine Ausweitung lohnt.
function absenderMitPacklistenFinden(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const bekannt=['kontakt@lieferant-j.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example'];
  const normal=x=>String(x).normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase();
  const proAbsender={}, seen=new Set(), start=Date.now();
  const query='has:attachment filename:xlsx newer_than:180d -in:trash -in:spam';
  let abgebrochen=false;
  for(let page=0;page<600;page+=50){
    if(Date.now()-start>240000){abgebrochen=true;break;}
    const threads=GmailApp.search(query,page,50);
    for(const thread of threads)for(const m of thread.getMessages()){
      if(seen.has(m.getId()))continue;seen.add(m.getId());
      const match=m.getFrom().match(/<([^>]+)>/);
      const sender=(match?match[1]:m.getFrom()).trim().toLowerCase();
      for(const a of m.getAttachments({includeInlineImages:false,includeAttachments:true})){
        const n=normal(a.getName());
        if(!/\.xlsx$/.test(n))continue;
        if(/invoice|rechnung|fatura/.test(n))continue;
        if(!/pack|liste|list|colis|delivery|shipment/.test(n))continue;
        if(!proAbsender[sender])proAbsender[sender]={anzahl:0,neueste:0,beispiele:[]};
        const e=proAbsender[sender];
        e.anzahl++;
        if(m.getDate().getTime()>e.neueste)e.neueste=m.getDate().getTime();
        if(e.beispiele.length<3)e.beispiele.push(a.getName());
      }
    }
    if(threads.length<50)break;
  }
  const liste=Object.keys(proAbsender).map(s=>({absender:s,...proAbsender[s]}));
  liste.sort((a,b)=>b.anzahl-a.anzahl);
  console.log('=== Absender mit Packlisten-artigen Anhaengen (letzte 180 Tage) ===');
  if(abgebrochen)console.log('(Hinweis: Suche wegen Laufzeitgrenze vorzeitig beendet, Zahlen sind Mindestwerte)');
  console.log('Durchsuchte Mails: '+seen.size);
  console.log('');
  liste.forEach(function(e){
    const markierung=bekannt.includes(e.absender)?'[BEREITS AKTIV]':'[NEU]';
    console.log(markierung+' '+e.absender+'  —  '+e.anzahl+' Dateien, zuletzt '
      +Utilities.formatDate(new Date(e.neueste),'Europe/Berlin','dd.MM.yyyy'));
    e.beispiele.forEach(b=>console.log('        '+b));
  });
  const neu=liste.filter(e=>!bekannt.includes(e.absender));
  const summeNeu=neu.reduce((a,e)=>a+e.anzahl,0);
  console.log('');
  console.log('ZUSAMMENFASSUNG: '+neu.length+' weitere Absender, zusammen '+summeNeu
    +' Dateien in 180 Tagen (~'+(summeNeu/26).toFixed(1)+' pro Woche zusaetzlich).');
  return liste;
}

// Setzt die "erledigt"-Markierung fuer genau einen bereits verarbeiteten
// Anhang zurueck, damit der naechste automatische Lauf ihn erneut aufgreift --
// z. B. wenn sich der Verarbeitungscode seitdem geaendert hat. Aendert nichts
// an bereits im Portal angelegten Bestellungen.
function avisAutoDateiZuruecksetzen(mailId,dateiname,lieferant){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const m=GmailApp.getMessageById(mailId);
  const treffer=m.getAttachments({includeInlineImages:false,includeAttachments:true}).filter(a=>a.getName()===dateiname);
  if(treffer.length!==1)throw Error('Anhang nicht eindeutig gefunden: '+treffer.length+' Treffer.');
  const hash=avisHash_(treffer[0].getBytes());
  const key='avis-auto-file-'+lieferant+'-'+hash;
  const props=PropertiesService.getUserProperties();
  const bisher=props.getProperty(key);
  props.deleteProperty(key);
  console.log('Zurueckgesetzt: '+key);
  console.log('Bisheriger Stand: '+(bisher||'(keiner)'));
  console.log('Der naechste automatische Lauf wird diese Datei erneut aufgreifen.');
}

// Einmaliger Gesamtcheck vor einer Abgabe/Uebergabe: zeigt auf einen Blick,
// welche der elf benoetigten Skripteigenschaften gesetzt sind. Passwoerter
// werden nie im Klartext gezeigt, nur ob und wie lang sie gesetzt sind.
// Schreibt nichts, meldet nichts an, nur eine lokale Uebersicht.
function avisSystemcheck(){
  const props=PropertiesService.getScriptProperties();
  const geheim=new Set(['DB_PASS','PORTAL_AUTOMATION_PASS']);
  const gruppen=[
    ['Testdatenbank (Neon)',['DB_HOST','DB_NAME','DB_USER','DB_PASS']],
    ['Gemeinsame Kernwerte',['AVIS_INSTANCE_KEY','AVIS_STATUS']],
    ['Lieferantennummern',['AVIS_SUPPLIER_LIEFERANT_I','AVIS_SUPPLIER_LIEFERANT_J']],
    ['Portal-Anmeldung',['PORTAL_COGNITO_CLIENT_ID','PORTAL_AUTOMATION_USER','PORTAL_AUTOMATION_PASS']]
  ];
  let fehlend=0;
  gruppen.forEach(function(g){
    console.log('=== '+g[0]+' ===');
    g[1].forEach(function(k){
      const v=props.getProperty(k);
      if(v==null){console.log('  FEHLT: '+k);fehlend++;}
      else if(geheim.has(k))console.log('  ok: '+k+' (gesetzt, '+v.length+' Zeichen)');
      else console.log('  ok: '+k+' = "'+v+'"');
    });
  });
  console.log('');
  console.log(fehlend?fehlend+' Eigenschaft(en) fehlen noch.':'Alle elf Eigenschaften sind gesetzt.');

  // Absenderliste zur Kontrolle mit anzeigen -- hier steckt der Test-Rest.
  console.log('');
  console.log('=== Aktive Absender-Zuordnung in pruefeNeuePacklisten (im Code, nicht Skripteigenschaft) ===');
  console.log('kontakt@lieferant-j.example -> Lieferant J');
  console.log('kontakt@lieferant-i.example -> Lieferant I');
  console.log('kontakt@lieferant-i.example -> Lieferant I');
}

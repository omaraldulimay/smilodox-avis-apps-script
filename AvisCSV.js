// Inhalt der bestehenden Datei LieferantAvisCSV.gs ersetzen. Vorhandene Mail-Prüfung behalten. Kein Trigger, kein Mail-Schreibzugriff, kein Portal.
/* Pure JavaScript: suitable for Apps Script V8 and local Node tests. */
function lieferantCsvKonvertieren_(stock, packing) {
  const norm = x => String(x ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const article = x => norm(x).replace(/_/g, '-');
  // Nur feste Schreibweisen/Übersetzungen; keine unscharfe Farbähnlichkeit.
  const color = x => {
    const n=norm(x).replace(/\s*\/\s*/g,'/');
    // 'ß' als 'b'/'ss' geschrieben ist eine uebliche Ersatzschreibweise, wenn das Zeichen
    // beim Lieferanten nicht verfuegbar ist (bei mehreren Lieferanten beobachtet) -- kein
    // mehrdeutiger Tippfehler, deshalb sicher automatisch zuordenbar.
    const aliases={'yellow':'gelb','white':'weiß','weib':'weiß','weiss':'weiß','grey melange':'grau melange','dunkelgrun':'dunkelgrün','dunkel grün':'dunkelgrün','black':'schwarz','anthrasit':'anthrazit','antrhazit':'anthrazit','anthrasit black':'anthrazit/schwarz','grun black':'grün/schwarz','black anthrasit':'schwarz/anthrazit','black yellow':'schwarz/gelb','schwarz/black':'schwarz','weiß/white':'weiß','marinablau':'marineblau','marinablue':'marineblau','royal blua':'royal blau','acidblack':'acid schwarz','grun':'grün','dunkelblue':'dunkelblau','dunkel blau':'dunkelblau','dunkel rot':'dunkelrot'};
    return aliases[n]||n;
  };
  // Vom Nutzer bestätigt: 2XL und XXL bezeichnen dieselbe Größe.
  const size = x => norm(x)==='2xl' ? 'xxl' : norm(x);
  const key = (a,c,s) => JSON.stringify([article(a),color(c),size(s)]);
  const index = new Map(), errors = [], result = new Map();
  const integer = (v, name) => {
    if (v === '' || v == null || !Number.isFinite(Number(v)) || Number(v)<0 || Math.abs(Number(v)-Math.round(Number(v)))>1e-7) throw Error(name+' muss eine nichtnegative ganze Zahl sein');
    return Math.round(Number(v));
  };
  const validEan = x => /^\d{13}$/.test(x) && (10-[...x.slice(0,12)].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10===Number(x[12]);
  // Zusaetzlich zum genauen Schluessel merken wir uns je Artikel, welche Farben
  // und Groessen es ueberhaupt gibt. Damit laesst sich bei einem Fehlschlag
  // sagen, WORAN es lag, statt nur "keine Zuordnung".
  const jeArtikel = new Map();
  for (const row of stock) {
    const attrs = Object.fromEntries(String(row.Attribut||'').split(/[;,]/).filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return [x.slice(0,i).trim(),x.slice(i+1).trim()];}));
    if (!attrs.Color || !attrs.Size) continue;
    const variant = String(row['Var.number']||'').trim();
    const base = variant.replace(/-[A-Za-z]+\d+$/, '');
    const k=key(base,attrs.Color,attrs.Size);
    if (!index.has(k)) index.set(k,[]);
    index.get(k).push({variant,ean:String(row.EAN13||'').trim(),description:attrs.Color+', '+attrs.Size});
    const artikelSchluessel=article(base);
    if(!jeArtikel.has(artikelSchluessel))jeArtikel.set(artikelSchluessel,{farben:new Set(),groessen:new Set()});
    jeArtikel.get(artikelSchluessel).farben.add(color(attrs.Color));
    jeArtikel.get(artikelSchluessel).groessen.add(size(attrs.Size));
  }
  const header = packing.findIndex(r=>r.includes('ART. NO')&&r.includes('SENT PCS.'));
  if(header<0) throw Error('Unbekannte Packlisten-Vorlage: LIEFERANT_I-Spalten fehlen');
  const h=packing[header], col=n=>{const i=h.indexOf(n);if(i<0)throw Error('Spalte fehlt: '+n);return i;};
  const a=col('ART. NO'),c=col('COLOUR'),s=col('SIZE'),q=col('SENT PCS.'),b=col('BOX PCS.'),u=col('PCS. IN THE BOX');
  let quantity=0,boxes=0,positions=0,matchedQuantity=0,platzhalterZaehler=0;
  packing.slice(header+1).forEach((row,offset)=>{
    const line=header+offset+2;
    if(!row[a]&&!row[c]&&!row[s])return; // footer totals / empty rows
    positions++;
    try {
      const qty=integer(row[q],'Menge'), cartons=integer(row[b],'Kartons'),per=integer(row[u],'Stück/Karton');
      if(qty!==cartons*per)throw Error('Menge stimmt nicht mit Kartons × Stück/Karton überein');
      quantity+=qty;boxes+=cartons;
      // Ab hier ist die Menge gesichert. Scheitert nur noch die Zuordnung,
      // wird die Zeile trotzdem mit einer eindeutigen Platzhalter-EAN
      // aufgenommen -- das Portal markiert sie dann selbst sichtbar als
      // "Keine Variante zugeordnet", und die Gesamtmenge der Bestellung
      // stimmt trotzdem mit der Packliste ueberein.
      try{
        if(!row[a]||!row[c]||!row[s])throw Error('Artikel, Farbe oder Größe fehlt');
        if(norm(row[s])==='mix')throw Error('Größe MIX: Aufteilung nach Einzelgrößen erforderlich');
        const hits=index.get(key(row[a],row[c],row[s]))||[];
        if(hits.length!==1)throw Error(hits.length?'Mehrdeutige Zuordnung':'Keine Zuordnung');
        const hit=hits[0];if(!validEan(hit.ean))throw Error('EAN fehlt oder ist ungültig');
        const existing=result.get(hit.variant);
        if(existing)existing[3]+=qty;else result.set(hit.variant,[hit.ean,hit.variant,hit.description,qty,'','']);
        matchedQuantity+=qty;
      }catch(zuordnungsFehler){
        platzhalterZaehler++;
        const platzhalterEan='9999999'+String(platzhalterZaehler).padStart(6,'0');
        // Genauere Ursache statt nur "keine Zuordnung": vergleicht mit dem,
        // was zu diesem Artikel im Lager tatsaechlich vorkommt.
        const artikelSchluessel=row[a]?article(row[a]):null;
        const vorhanden=artikelSchluessel?jeArtikel.get(artikelSchluessel):null;
        let ursache;
        if(!row[a]||!row[c]||!row[s]){
          const fehlend=[!row[a]&&'Artikelnummer',!row[c]&&'Farbe',!row[s]&&'Größe'].filter(Boolean).join('/');
          ursache=fehlend+' fehlt in Packliste';
        }
        else if(!vorhanden)ursache='Artikel '+row[a]+' existiert nicht im Lager';
        else if(!vorhanden.farben.has(color(row[c]))){
          // Nur als Vorschlag, nie automatisch uebernommen: falls eine Lager-
          // farbe die Packlisten-Farbe als Teilstring enthaelt (z. B. fehlt
          // nur ein Zusatz wie "Leo"), wird das explizit genannt.
          const gesucht=color(row[c]);
          const aehnlich=[...vorhanden.farben].filter(f=>f.includes(gesucht)||gesucht.includes(f));
          ursache='Farbe "'+row[c]+'" unbekannt'
            +(aehnlich.length?' — im Lager ähnlich: '+aehnlich.join('/')+' (bitte pruefen, nicht automatisch übernommen)'
                             :' (im Lager: '+[...vorhanden.farben].join('/')+')');
        }
        else if(!vorhanden.groessen.has(size(row[s])))ursache='Größe "'+row[s]+'" unbekannt (im Lager: '+[...vorhanden.groessen].join('/')+')';
        else ursache=zuordnungsFehler.message;
        // Ursache geht NUR ins Fehlerprotokoll (Blatt "CSV-Fehlerdetails"), nicht ins
        // BATCH-Feld der CSV: das Portal-Feld "Charge" wird beim Versand-Sync 1:1 als
        // Chargennummer an Lagerdienst uebertragen (lagerdienst.AvisPosition.Batch). Freitext
        // wuerde dort als angebliche Chargennummer landen.
        errors.push({line,article:row[a],color:row[c],size:row[s],quantity:row[q],reason:ursache});
        const rohdaten=[row[a],row[c],row[s]].filter(x=>x!=null&&x!=='').join(' ');
        // Ursache zusaetzlich als eigene NOTE-Spalte mitgeben, damit sie im Portal in der
        // separaten Kommentar-Spalte sichtbar ist (nicht in BATCH, siehe Kommentar oben).
        result.set('PLATZHALTER-'+platzhalterZaehler,[platzhalterEan,'UNGEKLÄRT-'+platzhalterZaehler,rohdaten||'ungeklärt',qty,'',(rohdaten?rohdaten+' – ':'')+ursache]);
      }
    }catch(e){errors.push({line,article:row[a],color:row[c],size:row[s],quantity:row[q],reason:e.message});}
  });
  if(!positions)throw Error('Keine Packlistenpositionen');
  const rows=[...result.values()];
  if(new Set(rows.map(r=>r[0])).size!==rows.length)errors.push({reason:'EAN ist mehreren Varianten zugeordnet'});
  const quote=x=>/[",\r\n]/.test(String(x))?'"'+String(x).replace(/"/g,'""')+'"':String(x);
  const csv=[['EAN','Var-Nr.','','QUANTITY','BATCH','NOTE'],...rows].map(r=>r.map(quote).join(',')).join('\n')+'\n';
  return {ready:errors.length===0,summary:{positions,variants:rows.length,quantity,boxes,matchedQuantity},errors,csv,rows};
}
function lieferantCsvIstPackliste_(name) {
  const n=String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /\.xlsx$/.test(n) && !/invoice|rechnung/.test(n) && n==='14.08.2026packing.xlsx';
}
// Nur manueller Selbst-Mail-Test; keine Nachricht wird verändert oder versendet.
function lieferantCsvQuelle_(temporary) {
  const me='kontakt@firma.example';
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==me)throw Error('Diesen Test bitte mit kontakt@firma.example ausführen.');
  const normal=x=>String(x).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const sender=x=>{const m=String(x).match(/<([^>]+)>/);return normal(m?m[1]:x);};
  const threads=GmailApp.search('from:kontakt@lieferant-j.example subject:"14.08.2026 Packing List ve Fatura" after:2026/08/13 before:2026/08/16 has:attachment -in:trash -in:spam',0,100);
  if(threads.length===100)throw Error('Zu viele Suchtreffer.');
  const seen=new Set();
  const messages=threads.flatMap(t=>t.getMessages()).filter(m=>{
    if(seen.has(m.getId()))return false;seen.add(m.getId());
    return sender(m.getFrom())==='kontakt@lieferant-j.example'&&normal(m.getSubject())==='14.08.2026 packing list ve fatura'&&m.getDate().getTime()>=Date.parse('2026-08-13T00:00:00Z')&&m.getDate().getTime()<Date.parse('2026-08-16T00:00:00Z');
  });
  if(messages.length!==1)throw Error('Erwartet genau eine Lieferant J-Beispielmail, gefunden: '+messages.length);
  const message=messages[0];
  const attachments=message.getAttachments({includeInlineImages:false,includeAttachments:true}).filter(a=>lieferantCsvIstPackliste_(a.getName()));
  if(attachments.length!==1)throw Error('Erwartet genau eine erkennbare XLSX-Packliste; gefunden: '+attachments.length);
  const attachment=attachments[0],folder='0AIMzqfJfA7IhUk9PVA';
  const hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,attachment.getBytes()).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
  const id=Drive.Files.create({name:'TEMP_Packliste_'+Utilities.getUuid(),mimeType:'application/vnd.google-apps.spreadsheet',parents:[folder]},attachment.copyBlob().setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),{supportsAllDrives:true,fields:'id'}).id;
  temporary.push(id);
  console.log('Quelle: Direkte Lieferant J-Mail; XLSX-Anhang als separate Testtabelle eingelesen.');
  return {book:SpreadsheetApp.openById(id),messageId:message.getId(),attachment:attachment.getName(),hash};
}

// Manueller Test: aktuelle Stock-Tabelle ausschließlich lesen; Packlisten-Anhang separat konvertieren.
function testLieferantAvisCsv(batchSource) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw Error('Ein Test läuft bereits.');
  const temporary=[];
  const runId=Utilities.getUuid(),started=new Date().toISOString();
  let sourceInfo=batchSource||{},csvLink='';
  try {
    avisAudit_([runId,started,'Gestartet',sourceInfo.id||'',sourceInfo.name||'','','','','','','','','','','']);
    if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
    const stockBook=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
    const source=batchSource ? lieferantBatchQuelle_(batchSource,temporary) : lieferantCsvQuelle_(temporary);
    sourceInfo=source;
    const packBook=source.book;
    const stockAliases={'Var.number':['Var.number','Var_number'],Attribut:['Attribut'],EAN13:['EAN13']};
    const stockSheets=stockBook.getSheets().filter(s=>{
      if(!s.getLastRow()||!s.getLastColumn())return false;
      const headers=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
      return Object.values(stockAliases).every(names=>names.some(n=>headers.includes(n)));
    });
    if(stockSheets.length!==1)throw Error('Stock-Blatt nicht eindeutig gefunden: '+stockSheets.length+' passende Blätter.');
    const sheet=stockSheets[0],headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0].map(x=>String(x).trim());
    if(sheet.getLastRow()<2)throw Error('Stock-Blatt enthält keine Artikelzeilen.');
    const columns={};
    Object.keys(stockAliases).forEach(h=>{
      const matches=headers.map((name,i)=>stockAliases[h].includes(name)?i:-1).filter(i=>i>=0);
      if(matches.length!==1)throw Error('Stock-Spalte fehlt oder ist doppelt: '+h);
      columns[h]=sheet.getRange(2,matches[0]+1,sheet.getLastRow()-1,1).getDisplayValues();
    });
    const stock=columns['Var.number'].map((_,i)=>Object.fromEntries(Object.keys(columns).map(h=>[h,columns[h][i][0]])));
    const candidates=packBook.getSheets().filter(s=>s.getRange(1,1,Math.min(20,s.getLastRow()),s.getLastColumn()).getDisplayValues().some(r=>r.includes('ART. NO')&&r.includes('SENT PCS.')));
    if(candidates.length!==1)throw Error('Packlisten-Blatt nicht eindeutig gefunden.');
    const stockHash=avisHash_(JSON.stringify(stock));
    const result=lieferantCsvKonvertieren_(stock,candidates[0].getDataRange().getValues());
    const packRows=candidates[0].getDataRange().getValues();
    const headerIndex=packRows.findIndex(r=>r.includes('ART. NO')&&r.includes('SENT PCS.'));
    const ph=packRows[headerIndex],qtyCol=ph.indexOf('SENT PCS.');
    const footer=packRows.slice(headerIndex+1).filter(r=>!r[ph.indexOf('ART. NO')]&&!r[ph.indexOf('COLOUR')]&&!r[ph.indexOf('SIZE')]&&r[qtyCol]!==''&&r[qtyCol]!=null&&Number(r[qtyCol])!==0);
    if(footer.length===1&&Number.isFinite(Number(footer[0][qtyCol]))&&Number(footer[0][qtyCol])!==result.summary.quantity){
      result.errors.push({reason:'Packlisten-Gesamtsumme '+footer[0][qtyCol]+' weicht von der berechneten Menge '+result.summary.quantity+' ab'});
      result.ready=false;
    }
    const folderId='0AIMzqfJfA7IhUk9PVA';
    const props=PropertiesService.getScriptProperties();
    const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify({attachmentHash:source.hash,errors:result.errors})+result.csv).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
    const outputs=[['csv',(batchSource ? batchSource.supplier+'_Packliste_'+batchSource.name.replace(/\.xlsx$/i,'').replace(/[^a-zA-Z0-9._-]/g,'_')+'_Avis_TEST' : 'Lieferant J_Packliste_14.08.2026_Avis_TEST')+(result.ready?'':'_UNVOLLSTAENDIG')+'_'+digest.slice(0,12)+'.csv',result.csv,'text/csv']];
    // Drive API mit Shared-Drive-Unterstützung; keine Eingabedatei wird verändert.
    const links=[];
    let csvAction="Vorhandene CSV wiederverwendet";
    outputs.forEach(([kind,name,text,mime])=>{
      const k='test-output-'+digest+'-'+kind;
      let id=props.getProperty(k);
      if(id){const meta=Drive.Files.get(id,{supportsAllDrives:true,fields:'id,trashed'});if(meta.trashed){props.deleteProperty(k);id=null;}}
      if(!id){
        const existing=Drive.Files.list({q:"'"+folderId+"' in parents and trashed = false and name = '"+name+"'",fields:'files(id)',supportsAllDrives:true,includeItemsFromAllDrives:true}).files||[];
        if(existing.length>1)throw Error('Mehrere gleichnamige Testausgaben gefunden.');
        if(!existing.length)csvAction='CSV neu erstellt';
        id=existing.length?existing[0].id:Drive.Files.create({name,mimeType:mime,parents:[folderId]},Utilities.newBlob(text,mime,name),{supportsAllDrives:true,fields:'id'}).id;
        props.setProperty(k,id);
      }
      links.push('https://drive.google.com/file/d/'+id+'/view');
      csvLink=links[links.length-1];
    });
    const logBook=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
    const logName='CSV-Ausgabe';
    const log=logBook.getSheetByName(logName)||logBook.getSheetByName('CSV-Test Lieferant')||logBook.insertSheet(logName);
    if(log.getName()!==logName)log.setName(logName);
    const titles=['Zeitpunkt','Status','Positionen','Stück gesamt','Kartons','Varianten zugeordnet','Stück zugeordnet','Offene Zeilen','CSV-Link','Prüfbericht-Link'];
    if(!log.getLastRow())log.appendRow(titles);
    else if(JSON.stringify(log.getRange(1,1,1,titles.length).getValues()[0])!==JSON.stringify(titles))throw Error('CSV-Testprotokoll hat andere Spalten; Ausgaben sind im Testordner gespeichert.');
    log.appendRow([Utilities.formatDate(new Date(),'Europe/Berlin','dd.MM.yyyy HH:mm:ss'),result.ready?'Testdatei vollständig':'Unvollständige Testvorschau',result.summary.positions,result.summary.quantity,result.summary.boxes,result.summary.variants,result.summary.matchedQuantity,result.errors.length,links[0],csvAction+' – Details im Blatt CSV-Fehlerdetails']);
    if(result.errors.length){
      const detail=logBook.getSheetByName('CSV-Fehlerdetails')||logBook.insertSheet('CSV-Fehlerdetails');
      const dh=['Zeitpunkt','Mail-ID','Packlisten-Zeile','Artikel','Farbe','Größe','Menge','Grund'];
      if(!detail.getLastRow())detail.appendRow(dh);
      else if(JSON.stringify(detail.getRange(1,1,1,dh.length).getValues()[0])!==JSON.stringify(dh))throw Error('Fehlerdetailblatt hat andere Spalten.');
      const safe=x=>{const v=String(x??'');return /^[\s]*[=+@-]/.test(v)?"'"+v:v;};
      detail.getRange(detail.getLastRow()+1,1,result.errors.length,dh.length).setValues(result.errors.map(e=>[Utilities.formatDate(new Date(),'Europe/Berlin','dd.MM.yyyy HH:mm:ss'),safe(source.messageId),e.line||'',safe(e.article),safe(e.color),safe(e.size),safe(e.quantity),safe(e.reason)]));
    }
    const packBasis=avisSourceRows_(runId,source,candidates[0].getName(),packRows);
    const stockBasis=avisStockRows_(runId,stock,packRows);
    const revision=avisRevision_(source,batchSource,runId);
    avisAudit_([runId,started,result.ready?'Vollständig (Test)':'Zuordnung prüfen',source.messageId,source.attachment,source.hash,stockBook.getId(),stockHash,'avis-test-v3',csvLink,csvAction,result.summary.quantity,result.summary.matchedQuantity,result.errors.length,revision+' | Prüfgrundlagen='+JSON.stringify({pack:packBasis,stock:stockBasis})]);
    // Datenbank nur bei fehlerfreier CSV. Ein Fehler hier darf den Lauf nicht abbrechen.
    let dbErgebnis={geschrieben:false,grund:'CSV unvollständig; es wird nichts geschrieben.'};
    if(result.ready){
      try{
        dbErgebnis=avisDbSchreiben_(result,source,batchSource?batchSource.supplier:'Lieferant J');
        console.log('Datenbank: '+(dbErgebnis.geschrieben
          ?'Avis '+dbErgebnis.avisId+' angelegt ('+dbErgebnis.positionen+' Positionen, '+dbErgebnis.stueck+' Stück).'
          :dbErgebnis.grund+(dbErgebnis.avisId?' (Avis '+dbErgebnis.avisId+')':'')));
      }catch(dbFehler){
        dbErgebnis={geschrieben:false,grund:'Datenbankfehler: '+dbFehler.message};
        console.error(dbErgebnis.grund);
      }
      avisAutoLog_(source.messageId,source.attachment,dbErgebnis.geschrieben?'In Datenbank geschrieben':'Datenbank übersprungen',dbErgebnis.grund||('Avis '+dbErgebnis.avisId));
    }

    // Echter Portal-Weg: laeuft AUCH bei offenen Positionen, im Unterschied
    // zum Testdatenbank-Block oben. Es entsteht eine Bestellung mit den
    // sicher zugeordneten Positionen; fehlende Zeilen stehen als Warnung in
    // der Referenz, sichtbar in der Portal-Liste. Nur wenn ueberhaupt keine
    // Position zugeordnet werden konnte, entsteht nichts. Eigene
    // Fehlerbehandlung, damit ein Problem hier weder den Lauf noch den
    // (unabhaengigen) Testdatenbank-Weg oben stoert.
    let portalErgebnis={geschrieben:false,grund:'Nicht versucht.'};
    try{
      portalErgebnis=avisPortalSchreiben_(result,source,batchSource?batchSource.supplier:'Lieferant J');
      console.log('Portal: '+(portalErgebnis.geschrieben
        ?'Bestellung '+portalErgebnis.bestellungId+' angelegt'+(portalErgebnis.vollstaendig?'.':' ('+portalErgebnis.offen+' Positionen weiterhin offen).')
        :portalErgebnis.grund));
    }catch(portalFehler){
      portalErgebnis={geschrieben:false,grund:'Portal-Fehler: '+portalFehler.message};
      console.error(portalErgebnis.grund);
    }
    avisAutoLog_(source.messageId,source.attachment,portalErgebnis.geschrieben?'Im Portal angelegt':'Portal übersprungen',portalErgebnis.grund||('Bestellung '+portalErgebnis.bestellungId));
    if(result.errors.length){
      console.warn('ZUORDNUNG PRÜFEN: '+result.errors.length+' offene Positionen. CSV ist unvollständig und darf nicht importiert werden.');
      console.warn('Quelle: '+source.attachment+' | Gmail-Message-ID: '+source.messageId);
      console.warn('Nachverfolgung: https://docs.google.com/spreadsheets/d/REPLACE_WITH_GOOGLE_ID/edit – Blatt CSV-Fehlerdetails');
      result.errors.slice(0,10).forEach(e=>console.warn('Packlisten-Zeile '+(e.line||'?')+' | Artikel '+(e.article||'?')+' | Farbe '+(e.color||'?')+' | Größe '+(e.size||'?')+' | Menge '+(e.quantity??'?')+' | '+e.reason));
      if(result.errors.length>10)console.warn('Alle weiteren offenen Positionen stehen im Prüfprotokoll.');
    }
    console.log(JSON.stringify({status:result.ready?'Testdatei vollständig':'Testvorschau mit offenen Zuordnungen',...result.summary,csvAktion:csvAction,output:links},null,2));
  } catch(e) {
    try{avisAudit_([runId,started,'Fehler',sourceInfo.messageId||sourceInfo.id||'',sourceInfo.attachment||sourceInfo.name||'','','','','',csvLink,'','','','',String(e.message)]);}catch(logError){console.error('Protokoll nicht erreichbar: '+logError.message);}
    throw e;
  } finally {
    try {for(const id of temporary){try{Drive.Files.update({trashed:true},id,null,{supportsAllDrives:true});}catch(e){console.log('Temporäre Testkopie konnte nicht in den Papierkorb verschoben werden: '+id+' – '+e.message);try{avisAudit_([runId,started,'Aufräumen nötig','','','','','','','','','','','',id+' – '+e.message]);}catch(ignored){}}}}
    finally {lock.releaseLock();}
  }
}

// Fünf zusätzliche XLSX-Packlisten. Jeder Aufruf verarbeitet eine Datei,
// damit die Laufzeitgrenze nicht mitten in fünf Konvertierungen erreicht wird.
function testFuenfWeiterePacklisten() {
  const queueLock=LockService.getUserLock();
  if(!queueLock.tryLock(1000)){console.log('Ein Test läuft bereits; dieser Aufruf wird übersprungen.');return;}
  try{return avisFuenfIntern_();}finally{queueLock.releaseLock();}
}
function avisFuenfIntern_() {
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const props=PropertiesService.getUserProperties();
  const key='avis-five-packlists-v1';
  let queue=JSON.parse(props.getProperty(key)||'null');
  if(!queue){
    const allowed=['kontakt@lieferant-j.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example'];
    const normal=x=>String(x).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const found=[],seen=new Set();
    const cutoff=Date.now()-90*86400000;
    const query='{'+allowed.map(a=>'from:'+a).join(' ')+'} newer_than:90d has:attachment -in:trash -in:spam';
    for(let page=0;page<500;page+=50){
      const threads=GmailApp.search(query,page,50);
      for(const thread of threads)for(const m of thread.getMessages()){
        if(seen.has(m.getId()))continue;seen.add(m.getId());
        const match=m.getFrom().match(/<([^>]+)>/),sender=(match?match[1]:m.getFrom()).trim().toLowerCase();
        if(!allowed.includes(sender)||m.getDate().getTime()<cutoff)continue;
        for(const a of m.getAttachments({includeInlineImages:false,includeAttachments:true})){
          const n=normal(a.getName());
          if(!/\.xlsx$/.test(n)||!/pack/.test(n)||/invoice|rechnung/.test(n))continue;
          if(m.getId()==='1a000956ace6cc13'||m.getId()==='1a086a79f397c1e5')continue;
          const hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,a.getBytes()).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
          found.push({id:m.getId(),name:a.getName(),hash,date:m.getDate().getTime(),supplier:sender===allowed[0]?'Lieferant J':'Lieferant I',subject:m.getSubject()});
        }
      }
      if(threads.length<50)break;
      if(page===450)throw Error('Suche unvollständig: mehr als 500 Threads.');
    }
    found.sort((a,b)=>b.date-a.date||a.name.localeCompare(b.name));
    const hashes=new Set();
    queue=found.filter(x=>{if(hashes.has(x.hash))return false;hashes.add(x.hash);return true;}).slice(0,5).map(x=>({...x,done:false}));
    if(queue.length<5)throw Error('Nur '+queue.length+' zusätzliche unterschiedliche Packlisten gefunden.');
    props.setProperty(key,JSON.stringify(queue));
  }
  const item=queue.find(x=>!x.done);
  if(!item){console.log('Alle fünf Packlisten wurden getestet. Ergebnisse im CSV-Testprotokoll.');return;}
  console.log('Zusatztest '+(queue.indexOf(item)+1)+'/5: '+item.supplier+' | '+item.name+' | '+item.subject);
  // Kein Produktionsimport; überarbeitete Packlisten werden als eigene Tests behandelt.
  testLieferantAvisCsv(item);
  item.done=true;props.setProperty(key,JSON.stringify(queue));
  console.log(queue.filter(x=>x.done).length+'/5 abgeschlossen. Für die nächste Packliste dieselbe Funktion erneut ausführen.');
}
function lieferantBatchQuelle_(item,temporary){
  const m=GmailApp.getMessageById(item.id);
  const attachments=m.getAttachments({includeInlineImages:false,includeAttachments:true}).filter(a=>a.getName()===item.name);
  const matches=attachments.filter(a=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,a.getBytes()).map(b=>(b&255).toString(16).padStart(2,'0')).join('')===item.hash);
  if(matches.length!==1)throw Error('Ausgewählter Anhang ist nicht eindeutig oder wurde verändert.');
  const id=Drive.Files.create({name:'TEMP_Packliste_'+Utilities.getUuid(),mimeType:'application/vnd.google-apps.spreadsheet',parents:['0AIMzqfJfA7IhUk9PVA']},matches[0].copyBlob().setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),{supportsAllDrives:true,fields:'id'}).id;
  temporary.push(id);
  return {book:SpreadsheetApp.openById(id),messageId:item.id,attachment:item.name,hash:item.hash};
}

// Wiederholungen behalten dieselben fünf Anhänge; keine Dateien werden gelöscht.
function fuenfTestsErneutVorbereiten(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw Error('Ein Test läuft bereits.');
  try{
    const props=PropertiesService.getUserProperties(),key='avis-five-packlists-v1';
    const queue=JSON.parse(props.getProperty(key)||'null');
    if(!queue)throw Error('Noch keine fünf Packlisten ausgewählt.');
    queue.forEach(x=>{x.done=false;});props.setProperty(key,JSON.stringify(queue));
    console.log('Die bisherigen fünf Packlisten sind erneut bereit. Jetzt testFuenfWeiterePacklisten ausführen.');
  }finally{lock.releaseLock();}
}
function avisHash_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value).map(b=>(b&255).toString(16).padStart(2,'0')).join('');}
function avisSafe_(v){if(typeof v==='number')return v;const s=String(v??'');return /^[\s]*[=+@-]/.test(s)?"'"+s:s;}
function avisTab_(name,headers){
  const book=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
  const tab=book.getSheetByName(name)||book.insertSheet(name);
  if(!tab.getLastRow())tab.appendRow(headers);
  else if(JSON.stringify(tab.getRange(1,1,1,headers.length).getValues()[0])!==JSON.stringify(headers))throw Error('Unerwartete Spalten im Protokoll: '+name);
  return tab;
}
function avisAudit_(row){
  avisTab_('Laufnachweis',['Lauf-ID','Start UTC','Status','Mail-ID','Anhang','Anhang SHA256','Stock-ID','Stock SHA256','Script-Version','CSV-Link','Dateiaktion','Packlisten-Menge','CSV-Menge','Offene Positionen','Hinweis']).appendRow(row.map(avisSafe_));
}
function avisRevision_(source,item,runId){
  const tab=avisTab_('Packlisten-Versionen',['Lauf-ID','Mail-ID','Dateiname','Anhang SHA256','Lieferant','Status']);
  const supplier=item?.supplier||'Lieferant J';
  const prior=tab.getLastRow()>1?tab.getRange(2,1,tab.getLastRow()-1,6).getValues():[];
  const normal=x=>String(x).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const date=x=>normal(x).match(/\d{2}[. _-]\d{2}[. _-]\d{4}/)?.[0].replace(/[. _-]/g,'');
  const same=prior.some(r=>r[3]===source.hash&&r[4]===supplier);
  const changed=prior.some(r=>r[4]===supplier&&date(r[2])&&date(r[2])===date(source.attachment)&&r[3]!==source.hash);
  const revised=/revis|revize|revid|correct|korrig/.test(normal(source.attachment+' '+(item?.subject||'')));
  const status=same?'Identischer Anhang erneut geprüft':(changed||revised)?'Mögliche neue Version – Lieferung und Gültigkeit prüfen; nichts ersetzt':'Erstmals erfasster Anhang';
  tab.appendRow([runId,source.messageId,source.attachment,source.hash,supplier,status].map(avisSafe_));
  return status;
}
function avisSourceRows_(runId,source,sheetName,rows){
  const tab=avisTab_('Packlisten-Prüfgrundlage',['Lauf-ID','Mail-ID','Anhang','Tabellenblatt','Excel-Zeile','Originalwerte JSON']);
  const values=rows.map((r,i)=>[runId,source.messageId,source.attachment,sheetName,i+1,JSON.stringify(r)].map(avisSafe_));
  return avisBasisSpeichern_(tab,values,runId,6);
}

function avisStockRows_(runId,stock,packing){
  const header=packing.findIndex(r=>r.includes('ART. NO')&&r.includes('SENT PCS.'));
  const col=packing[header].indexOf('ART. NO');
  const normalize=x=>String(x??'').trim().toLowerCase().replace(/_/g,'-');
  const articles=new Set(packing.slice(header+1).map(r=>normalize(r[col])).filter(Boolean));
  const relevant=stock.filter(r=>articles.has(normalize(String(r['Var.number']).replace(/-[A-Za-z]+\d+$/,''))));
  const tab=avisTab_('Stock-Prüfgrundlage',['Lauf-ID','Variantennummer','Attribut','EAN13']);
  return avisBasisSpeichern_(tab,relevant.map(r=>[runId,r['Var.number'],r.Attribut,r.EAN13].map(avisSafe_)),runId,4);
}

// Gezielte Wiederholung des bereits ausgewählten Lieferant J-Anhangs.
function testLieferantJErneut(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const queue=JSON.parse(PropertiesService.getUserProperties().getProperty('avis-five-packlists-v1')||'[]');
  const matches=queue.filter(x=>x.id==='19f75b156449bfb3');
  if(matches.length!==1)throw Error('Lieferant J-Packliste vom 18.07. nicht eindeutig in der bisherigen Testauswahl gefunden.');
  testLieferantAvisCsv(matches[0]);
}

// Zentraler Einstieg für den späteren 15-Minuten-Trigger.
// Erster Lauf: letzte 36 Stunden. Danach fortlaufend mit Überlappung.
// Pro Lauf höchstens ein neuer Anhang; Rückstand bleibt beim nächsten Lauf sichtbar.
function pruefeNeuePacklisten(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const lock=LockService.getUserLock();
  if(!lock.tryLock(1000)){console.log('Mail-Prüfung läuft bereits; Aufruf übersprungen.');return;}
  try{
    const props=PropertiesService.getUserProperties(),now=Date.now();
    if(now-Number(props.getProperty('avis-basis-cleanup')||0)>86400000){
      pruefgrundlagenAufraeumen();
      props.setProperty('avis-basis-cleanup',String(now));
    }
    let watermark=Number(props.getProperty('avis-auto-start-v1'));
    if(!watermark){watermark=now-36*3600000;props.setProperty('avis-auto-start-v1',String(watermark));}
    const from=watermark-3600000;
    // Wert = Lieferant, dem eingehende Anhaenge dieses Absenders zugeordnet werden.
    const absenderLieferant={
      'kontakt@lieferant-j.example':'Lieferant J',
      'kontakt@lieferant-i.example':'Lieferant I',
      'kontakt@lieferant-i.example':'Lieferant I',
      'kontakt@lieferant-i.example':'Lieferant I'
    };
    const allowed=Object.keys(absenderLieferant);
    const query='{'+allowed.map(a=>'from:'+a).join(' ')+'} after:'+Math.floor(from/1000)+' has:attachment -in:trash -in:spam';
    const seen=new Set(),start=Date.now();
    for(let offset=0;offset<500;offset+=50){
      if(Date.now()-start>180000){console.log('Suche wird beim nächsten Lauf fortgesetzt; Zeitfenster bleibt erhalten.');return;}
      const threads=GmailApp.search(query,offset,50);
      for(const thread of threads)for(const m of thread.getMessages()){
        if(seen.has(m.getId()))continue;seen.add(m.getId());
        const match=m.getFrom().match(/<([^>]+)>/),sender=(match?match[1]:m.getFrom()).trim().toLowerCase();
        if(!allowed.includes(sender)||m.getDate().getTime()<from||m.getDate().getTime()>now)continue;
        for(const attachment of m.getAttachments({includeInlineImages:false,includeAttachments:true})){
          const kind=avisAutoAttachment_(attachment.getName());
          if(kind==='ignore')continue;
          const supplier=absenderLieferant[sender];
          const hash=avisHash_(attachment.getBytes());
          // Inhaltsgleiches Dokument desselben Lieferanten wird auch in neuer Mail übersprungen.
          const key='avis-auto-file-'+supplier+'-'+hash;
          const state=JSON.parse(props.getProperty(key)||'null');
          if(state&&(state.status==='done'||state.status==='manual'))continue;
          if(kind==='manual'){
            avisAutoLog_(m.getId(),attachment.getName(),'Manuell prüfen','Nicht eindeutig unterstützte Packliste; keine CSV erstellt.');
            props.setProperty(key,JSON.stringify({status:'manual'}));continue;
          }
          const item={id:m.getId(),name:attachment.getName(),hash,date:m.getDate().getTime(),supplier,subject:m.getSubject()};
          const attempts=(state?.attempts||0)+1;
          try{
            testLieferantAvisCsv(item);
          }catch(e){
            avisAutoLog_(item.id,item.name,'Fehler',String(e.message)+(attempts>=3?' – Nach drei Versuchen manuell prüfen.':' – Erneuter Versuch beim nächsten Lauf.'));
            props.setProperty(key,JSON.stringify({status:attempts>=3?'manual':'retry',attempts}));
            throw e;
          }
          // Unvollständige CSVs gelten als geprüft; Warnungen bleiben zur manuellen Klärung offen.
          avisAutoLog_(item.id,item.name,'Verarbeitet','CSV und Prüfprotokoll erstellt/geprüft; Vollständigkeit im CSV-Testprotokoll.');
          props.setProperty(key,JSON.stringify({status:'done',attempts}));
          console.log('Eine neue Packliste verarbeitet. Weitere folgen beim nächsten Lauf.');return;
        }
      }
      if(threads.length<50){props.setProperty('avis-auto-start-v1',String(now));console.log('Keine weiteren neuen Packlisten. Bereits verarbeitete Anhänge werden übersprungen.');return;}
    }
    throw Error('Mehr als 500 Mail-Threads im Zeitfenster; Suchzeitraum wurde nicht vorgerückt. Bitte prüfen.');
  }catch(e){
    try{avisAutoLog_('','','Lauf fehlgeschlagen',String(e.message));}catch(logError){console.error('Fehlerprotokoll nicht erreichbar: '+logError.message);}
    throw e;
  }finally{lock.releaseLock();}
}
function avisAutoAttachment_(name){
  const n=String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/invoice|rechnung|fatura/.test(n))return 'ignore';
  if(/\.xlsx$/.test(n)&&/pack/.test(n))return 'process';
  if(/\.(xlsx|xls|csv)$/.test(n)||(/\.pdf$/.test(n)&&/pack/.test(n)))return 'manual';
  return 'ignore';
}
function avisAutoLog_(id,name,status,note){
  avisTab_('Automatik-Protokoll',['Zeitpunkt UTC','Mail-ID','Anhang','Status','Hinweis']).appendRow([new Date().toISOString(),id,name,status,note].map(avisSafe_));
}

// Identische Datensätze wiederverwenden. Der Laufnachweis verweist auf deren Lauf-ID.
function avisBasisSpeichern_(tab,values,runId,width){
  if(!values.length)return '';
  const rows=tab.getLastRow()>1?tab.getRange(2,1,tab.getLastRow()-1,width).getValues():[];
  const groups=new Map();
  for(const row of rows){if(!groups.has(row[0]))groups.set(row[0],[]);groups.get(row[0]).push(row.slice(1));}
  const wanted=JSON.stringify(values.map(r=>r.slice(1)));
  for(const [id,data] of groups)if(JSON.stringify(data)===wanted)return id;
  tab.getRange(tab.getLastRow()+1,1,values.length,width).setValues(values);
  return runId;
}

// Nur Prüfgrundlagen löschen, 90 Tage nach ihrer letzten dokumentierten Verwendung.
// Unbekannte Zeitstempel bleiben erhalten. CSVs und Fehlerprotokolle bleiben unverändert.
function pruefgrundlagenAufraeumen(){
  if(Session.getEffectiveUser().getEmail().toLowerCase()!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example starten.');
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw Error('Verarbeitung läuft. Bereinigung später erneut starten.');
  try{
    const book=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
    const old=book.getSheetByName('CSV-Test Lieferant');
    if(old&&!book.getSheetByName('CSV-Ausgabe'))old.setName('CSV-Ausgabe');
    const audit=book.getSheetByName('Laufnachweis');
    if(!audit||audit.getLastRow()<2)return;
    const used={pack:new Map(),stock:new Map()};
    for(const row of audit.getRange(2,1,audit.getLastRow()-1,15).getValues()){
      const time=new Date(row[1]).getTime();if(!Number.isFinite(time))continue;
      for(const type of ['pack','stock'])used[type].set(row[0],Math.max(used[type].get(row[0])||0,time));
      const match=String(row[14]).match(/Prüfgrundlagen=(\{[^}]+\})/);
      if(match){
        const refs=JSON.parse(match[1]);
        for(const type of ['pack','stock'])if(refs[type])used[type].set(refs[type],Math.max(used[type].get(refs[type])||0,time));
      }
    }
    const cutoff=Date.now()-90*86400000;
    for(const [name,type] of [['Packlisten-Prüfgrundlage','pack'],['Stock-Prüfgrundlage','stock']]){
      const tab=book.getSheetByName(name);if(!tab||tab.getLastRow()<2)continue;
      const ids=tab.getRange(2,1,tab.getLastRow()-1,1).getValues();
      let end=null,count=0;
      for(let i=ids.length-1;i>=-1;i--){
        const time=i>=0?used[type].get(ids[i][0]):undefined;
        if(i>=0&&time!==undefined&&time<cutoff){if(end===null)end=i;}
        else if(end!==null){const length=end-i;tab.deleteRows(i+3,length);count+=length;end=null;}
      }
      console.log(name+': '+count+' alte Zeilen entfernt');
    }
  }finally{lock.releaseLock();}
}

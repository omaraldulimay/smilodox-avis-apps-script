// Ersetzt den bisherigen Code in LieferantMailPrüfungs.gs vollständig.
// Nur Mail-Erkennung plus Protokoll. Keine Avis, kein Portal-Upload.
function pruefeLieferantenMails() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000)){console.log('Ein anderer Test läuft. Bitte später erneut starten.');return;}
  try {
    const account=Session.getEffectiveUser().getEmail().toLowerCase();
    if(account!=='kontakt@firma.example')throw Error('Bitte mit kontakt@firma.example ausführen.');
    // Zugriff vor der Mail-Abfrage prüfen; ausschließlich das ausdrücklich verlinkte Blatt.
    const sheet=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID').getSheetById(0);
    if(!sheet)throw Error('Testprotokoll: Tabellenblatt mit ID 0 fehlt.');
    const headers=['Zeitpunkt (Berlin)','Konto','Status','Gefundene Mails','Packlisten-Kandidaten','Unklare Tabellen','Hinweis'];
    if(sheet.getLastRow()===0)sheet.getRange(1,1,1,headers.length).setValues([headers]);
    else if(JSON.stringify(sheet.getRange(1,1,1,headers.length).getValues()[0])!==JSON.stringify(headers))throw Error('Testprotokoll enthält andere Spalten. Keine Daten überschrieben.');
    // Neue Spalten H–K ergänzen; vorhandene Protokollzeilen bleiben erhalten.
    const extra=['Absender','Betreff','Anhang-Dateiname','Mail-Datum'];
    const existing=sheet.getRange(1,8,1,4).getValues()[0];
    if(existing.some((v,i)=>v!==''&&v!==extra[i]))throw Error('Spalten H–K sind bereits anders belegt. Keine Daten überschrieben.');
    sheet.getRange(1,8,1,4).setValues([extra]);
    // Mailtexte als Text behandeln, niemals als Tabellenformel.
    const safe=value=>{const s=String(value??'');return /^[\s]*[=+@-]/.test(s)?"'"+s:s;};
    const stamp=()=>Utilities.formatDate(new Date(),'Europe/Berlin','dd.MM.yyyy HH:mm:ss');
    let result;
    try{result=sammleLieferantenTest_();}
    catch(error){
      sheet.appendRow([stamp(),account,'Fehler','','','','Mail-Prüfung fehlgeschlagen. Details unter Apps Script > Ausführungen.']);
      throw error;
    }
    const candidates=result.mails.reduce((n,m)=>n+m.packlistenKandidaten.length,0);
    const unclear=result.mails.reduce((n,m)=>n+m.weitereTabellenZurPruefung.length,0);
    sheet.appendRow([stamp(),account,result.begrenzt?'Suche unvollständig':unclear?'Prüfung nötig':'Erkennung abgeschlossen',result.gefundeneMails,candidates,unclear,'Letzte 90 Tage; jeder Lauf zählt erneut. Nur Dateinamen geprüft, nichts verarbeitet.']);
    const details=[];
    for(const mail of result.mails){
      for(const name of mail.packlistenKandidaten){
        details.push([stamp(),account,'Packlisten-Kandidat','','','','Nur Dateiname geprüft; Inhalt noch nicht bestätigt.',safe(mail.absender),safe(mail.betreff),safe(name),Utilities.formatDate(new Date(mail.datum),'Europe/Berlin','dd.MM.yyyy HH:mm:ss')]);
      }
      for(const name of mail.weitereTabellenZurPruefung){
        details.push([stamp(),account,'Anhang prüfen','','','','Unbekannter Tabellen-Dateiname; keine Verarbeitung.',safe(mail.absender),safe(mail.betreff),safe(name),Utilities.formatDate(new Date(mail.datum),'Europe/Berlin','dd.MM.yyyy HH:mm:ss')]);
      }
    }
    if(details.length)sheet.getRange(sheet.getLastRow()+1,1,details.length,11).setValues(details);
    console.log('Testprotokoll aktualisiert: '+result.gefundeneMails+' Mails, '+candidates+' Packlisten-Kandidaten, '+unclear+' unklare Tabellen.');
  } finally {lock.releaseLock();}
}

/** Manueller Erkennungstest. Keine E-Mail-Änderung, keine Uploads, kein Trigger.
 * Mail-IDs werden in diesem Test NICHT als verarbeitet markiert.
 */
function sammleLieferantenTest_() {
  const expected='kontakt@firma.example';
  const account=Session.getEffectiveUser().getEmail().toLowerCase();
  if(account!==expected)throw Error('Bitte mit dem Google-Konto '+expected+' starten. Aktuelles Konto: '+account);
  const senders=['kontakt@lieferant-j.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example','kontakt@lieferant-i.example'];
  const address=value=>{const m=String(value).match(/<([^>]+)>/);return(m?m[1]:String(value)).trim().toLowerCase();};
  const normalize=value=>String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const query='{'+senders.map(s=>'from:'+s).join(' ')+'} newer_than:90d has:attachment -in:trash -in:spam';
  const cutoff=Date.now()-90*86400000;
  const results=[];const seen=new Set();let start=0;let begrenzt=false;
  while(true){
    const threads=GmailApp.search(query,start,50);
    for(const thread of threads){
      for(const message of thread.getMessages()){
        if(seen.has(message.getId())||!senders.includes(address(message.getFrom()))||message.getDate().getTime()<cutoff)continue;
        seen.add(message.getId());
        const files=message.getAttachments({includeInlineImages:false,includeAttachments:true}).map(a=>a.getName());
        if(!files.length)continue;
        const packing=files.filter(name=>{const n=normalize(name);return /\.xlsx$/.test(n)&&!/invoice|rechnung/.test(n)&&/packing[\s_-]*list|packliste/.test(n);});
        const uncertainExcel=files.filter(name=>/\.(xlsx|xls|csv)$/i.test(name)&&!packing.includes(name)&&!/invoice|rechnung/.test(normalize(name)));
        if(!packing.length&&!uncertainExcel.length)continue;
        results.push({absender:address(message.getFrom()),betreff:message.getSubject(),datum:message.getDate().toISOString(),packlistenKandidaten:packing,weitereTabellenZurPruefung:uncertainExcel,status:'Nur erkannt – nicht verarbeitet'});
      }
    }
    start+=threads.length;
    if(threads.length<50)break;
    if(start>=500){begrenzt=true;console.log('Hinweis: Test auf 500 Mailverläufe begrenzt; Ergebnis eventuell unvollständig.');break;}
  }
  return {konto:account,gefundeneMails:results.length,begrenzt,mails:results};
}

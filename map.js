/* Map of the places that have one confirmed address point. Leaflet comes from assets/, tiles from swisstopo.
   Every visible word comes from the translator passed in as t(key, params). */
(() => {
  'use strict';
  window.MinitandemMap={mount(container,items,t=key=>key){
    // The plotting rule is the catalogue's (catalogue.js onMap), the same one the caption and the address lists count with.
    const mapped=items.filter(window.MinitandemCatalogue.onMap);
    if(!mapped.length){container.textContent=t('map.noPoints');return ()=>{};}
    if(!window.L){container.textContent=t('map.notLoaded');return ()=>{};}
    const map=L.map(container,{scrollWheelZoom:false,zoomControl:false});
    L.control.zoom({position:'topright',zoomInTitle:t('map.zoomIn'),zoomOutTitle:t('map.zoomOut')}).addTo(map);
    const note=document.querySelector('#map-error');
    let loaded=false;
    const timeout=setTimeout(()=>{if(!loaded&&note)note.hidden=false;},10000);
    L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',{maxZoom:18,referrerPolicy:'no-referrer',attribution:'&copy; Data: <a href="https://www.geo.admin.ch/en/general-terms-of-use-fsdi" target="_blank" rel="noopener noreferrer">swisstopo</a>'}).on('tileload',()=>{loaded=true;clearTimeout(timeout);}).on('tileerror',()=>{if(note)note.hidden=false;}).addTo(map);
    const markers=L.markerClusterGroup({showCoverageOnHover:false,maxClusterRadius:45,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches,iconCreateFunction(cluster){
      const count=cluster.getAllChildMarkers().reduce((sum,marker)=>sum+marker.options.recordCount,0);
      cluster.options.title=t('map.cluster',{n:count});
      return L.divIcon({className:'place-cluster',html:String(count),iconSize:[44,44],iconAnchor:[22,22]});
    }});
    const groups=new Map();
    for(const a of mapped){const key=a.geo.lat+','+a.geo.lon;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
    const bounds=[];
    for(const group of groups.values()){
      const a=group[0],latlng=[a.geo.lat,a.geo.lon];bounds.push(latlng);
      const popup=document.createElement('div');popup.className='map-popup';
      const address=document.createElement('p');address.textContent=a.geo.label;popup.append(address);
      for(const place of group){const button=document.createElement('button');button.type='button';button.className='linkbtn';button.dataset.open=place.id;button.textContent=place.name;popup.append(button);}
      const marker=L.marker(latlng,{recordCount:group.length,icon:L.divIcon({className:'place-marker',html:String(group.length),iconSize:[44,44],iconAnchor:[22,22]}),title:group.map(a=>a.name).join('; '),alt:group.map(a=>a.name).join('; '),keyboard:true});
      marker.bindPopup(popup,{maxWidth:260}).addTo(markers);
    }
    markers.addTo(map);
    map.fitBounds(bounds,{padding:[30,30],maxZoom:14});
    const controls=container.querySelectorAll('.leaflet-control-zoom a');
    controls.forEach(a=>a.setAttribute('aria-label',a.title));
    return ()=>{clearTimeout(timeout);map.remove();};
  }};
})();

# Izbori 2026 – mapa rezultata

Mapa rezultata parlamentarnih izbora 2026. Opštine i biračka mesta su obojeni po pobedniku. Nijansa boje pokazuje kolika je prednost.

- Rezultati: [Republička izborna komisija](https://www.rik.parlament.gov.rs/542645/rezultati/)
- Granice: © OpenStreetMap saradnici
- Lokacije biračkih mesta: [rezultatiizbora.rs](https://rezultatiizbora.rs). Oblasti biračkih mesta su približne (Voronoi podela unutar opštine).

## Lokalno

```
npm start                 # http://localhost:8080, osvežava rezultate na 3 min
npm run update:results    # jednokratno preuzimanje rezultata sa RIK-a
npm install               # potrebno samo za build:geo i build:stations
npm run build:geo
npm run build:stations
```

## Hosting

GitHub Actions (`.github/workflows/pages.yml`) objavljuje folder `public/` na GitHub Pages. Rezultate preuzima sa RIK-a pri svakom push-u i na svakih ~5 minuta.

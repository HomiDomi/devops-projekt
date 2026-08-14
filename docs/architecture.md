# Arhitektura — Secure Event Ticketing Platform



Ovaj dokument opisuje arhitekturu sustava kako je deployan na OpenShift, tok

podataka kroz komponente, i obrazloženje ključnih dizajnerskih odluka.

Za operativne upute (deploy, health-check, troubleshooting) vidi

`docs/runbook.md`. Za sigurnosne izvještaje (Trivy skenovi) vidi

`docs/security/`.



## Pregled sustava



Aplikacija je klasična web-ticketing platforma s asinkronom obradom

narudžbi: korisnik kupuje kartu preko frontenda, API odmah potvrđuje prijem

i stavlja narudžbu u red čekanja (Redis), a zaseban worker proces asinkrono

obrađuje red i upisuje konačne narudžbe u trajnu bazu (Postgres). Ovaj

obrazac (immediate ack + async processing) odvaja korisničko iskustvo

(brz odgovor) od stvarne obrade (koja može uključivati provjere dostupnosti,

plaćanje, itd. u budućim proširenjima).



## Dijagram komponenti i toka podataka



```

                          Internet

                             │

                             │ HTTPS (edge TLS termination)

                             ▼

                    ┌──────────────────┐

                    │  OpenShift Route │

                    │  (Router/Ingress)│

                    └────────┬─────────┘

                             │

              ┌──────────────┴──────────────┐

              │                              │

              ▼                              ▼

     ┌─────────────────┐           ┌─────────────────┐

     │  Route: frontend │           │   Route: api    │

     └────────┬─────────┘           └────────┬─────────┘

              │                              │

              ▼                              ▼

     ┌─────────────────┐           ┌─────────────────┐

     │ Service: frontend│           │  Service: api   │

     │   ClusterIP:3000 │           │  ClusterIP:8080 │

     └────────┬─────────┘           └────────┬─────────┘

              │                              │

              ▼                              ▼

     ┌─────────────────┐  HTTP GET/POST ┌─────────────────┐

     │  Pod: frontend   │───────────────▶│    Pod: api      │

     │  (frontend-sa)   │  /events       │    (api-sa)      │

     │  Node.js + HTML  │  /tickets/...  │  Node.js/Express │

     └──────────────────┘                └────────┬────┬────┘

                                                    │    │

                                     TCP 5432       │    │  TCP 6379

                                    (upit eventa)   │    │  (queue push)

                                                    ▼    ▼

                            ┌──────────────────┐  ┌──────────────────┐

                            │  Service: postgres│  │  Service: redis  │

                            │  ClusterIP:5432   │  │  ClusterIP:6379  │

                            └────────┬───────────┘  └────────┬─────────┘

                                     │                        │

                                     ▼                        ▼

                            ┌──────────────────┐  ┌──────────────────┐

                            │  Pod: postgres    │  │   Pod: redis     │

                            │  (PVC-backed)     │  │  (bez PVC-a,     │

                            │  ticket_orders    │  │   efemeran)      │

                            └────────▲───────────┘  └────────▲─────────┘

                                     │                        │

                                     │ TCP 5432               │ TCP 6379

                                     │ (upis narudžbe)        │ (queue pop)

                                     │                        │

                                     └────────────┬───────────┘

                                                   │

                                          ┌──────────────────┐

                                          │   Pod: worker     │

                                          │   (worker-sa)     │

                                          │  Node.js, nema    │

                                          │  Service/port     │

                                          └──────────────────┘

```



## Tok podataka — kupnja karte



1. Korisnik otvara `frontend` preko vanjskog Route-a (HTTPS, edge TLS).

2. Frontend dohvaća listu dostupnih eventa preko `GET /events` na `api`.

3. Korisnik ispuni formu i klikne "Purchase" → frontend šalje

   `POST /tickets/purchase` na `api`.

4. `api` validira zahtjev, upisuje poruku u Redis red (`ticket_orders`

   queue) i odmah vraća `{"message":"Order queued","orderId":"..."}`

   korisniku — korisnik ne čeka da se narudžba stvarno obradi.

5. `worker`, koji kontinuirano sluša Redis red, pokupi poruku, obradi je i

   upiše konačan zapis u Postgres tablicu `ticket_orders`.

6. Worker nema HTTP endpoint niti Service — komunicira isključivo izlazno

   prema Redisu i Postgresu.



## Ključne arhitekturne odluke



### Zašto interni ImageStream za Postgres umjesto javnog Docker Hub image-a



Javni `docker.io/library/postgres` image pretpostavlja fiksni UID/GID i

pokušava `chmod`/`chown` operacije na data direktoriju pri startu.

OpenShiftov `restricted` SCC dodjeljuje proizvoljni UID iz namespaceovog

raspona, pa te operacije nemaju dozvolu. Interni ImageStream

`openshift/postgresql:15-el9` je dizajniran za rad s proizvoljnim UID-om

(standardna OpenShift/Red Hat praksa za "arbitrary UID" kompatibilnost) i

već je zrcaljen u clusteru, bez potrebe za vanjskom autentifikacijom prema

`registry.redhat.io`.



### Zašto Redis bez perzistentnog storagea



Redis u ovoj arhitekturi služi isključivo kao efemerni message queue

između `api` i `worker` — nije izvor istine za podatke (to je Postgres).

Ako Redis pod restarta i izgubi red čekanja, gubi se samo trenutno

neobrađene narudžbe u tranzitu, ne povijest narudžbi. Ovaj kompr omis

o	pravdavaizostanak PVC-a: RDB persistencija je eksplicitno isključena

(`--save ""`) da Redis ne pokuša pisati na disk bez dozvole i ne uđe u

zaštitni read-only mod.



### Zašto BuildConfig s Docker strategy umjesto Source-to-Image (S2I)



Projekt već ima definirane, testirane multi-stage Containerfileove (iz

lokalnog Podman Compose okruženja) s jasno odvojenim `dev`/`production`

fazama. Docker strategy BuildConfig ponovno koristi te iste Containerfileove

bez duplog održavanja build logike u dva formata. Bitna napomena: OpenShift

BuildConfig Docker strategy nema polje ekvivalentno `docker build --target`

za biranje faze u multi-stage Dockerfileu — build uvijek producira image na

**zadnjoj** `FROM` instrukciji u fileu. Svi Containerfileovi u ovom projektu

su namjerno posloženi tako da je `production` zadnja faza.



### Zašto namjenski ServiceAccount po komponenti



Nijedna komponenta (api/worker/frontend) ne poziva Kubernetes API — nema

potrebe za bilo kakvim RBAC ovlastima prema clusteru. Umjesto da sve tri

komponente dijele zajednički `default` ServiceAccount namespacea, svaka ima

svoj vlastiti (`api-sa`, `worker-sa`, `frontend-sa`) s

`automountServiceAccountToken: false`. Ovo je least-privilege princip u

praksi: čak i ako se jedna komponenta kompromitira, nema mogućnosti

zloupotrebe K8s API tokena jer token nije ni montiran u pod, i identitet je

izoliran od drugih komponenti.



### Zašto NetworkPolicy segmentacija s default-deny bazom



Polazna točka je `default-deny-all` — sav promet unutar namespacea je

zabranjen dok se eksplicitno ne dopusti. Svaka komponenta ima definiran

točan skup dozvoljenih izvora/odredišta:



| Komponenta | Prima promet od | Šalje promet prema |

|---|---|---|

| `frontend` | OpenShift Router (vanjski) | `api`, DNS |

| `api` | `frontend`, Router | `postgres`, `redis`, DNS |

| `worker` | *(ništa)* | `postgres`, `redis`, DNS |

| `postgres` | `api`, `worker` | *(ništa, samo ingress pravila)* |

| `redis` | `api`, `worker` | *(ništa, samo ingress pravila)* |



Ovo znači da čak i kad bi netko dobio pristup unutar clustera (npr. kroz

kompromitirani pod u drugom namespaceu), ne bi mogao izravno kontaktirati

`postgres` ili `redis` osim preko `api`/`worker` puta, i ne bi mogao

zaobići `api` da izravno napadne `worker` (koji uopće nema otvoren ulazni

port).



**Bitna OpenShift specifičnost:** DNS egress pravila moraju ciljati port

**5353** (interni port OpenShiftovog CoreDNS-a), ne standardni port 53 —

Service `dns-default` prevodi 53→5353, a NetworkPolicy se evaluira nakon

tog prijevoda na stvarnom pod IP:portu.



### Zašto edge TLS termination na Route-ovima



TLS se terminira na razini OpenShift routera (edge), ne unutar samih

aplikacijskih podova. Ovo pojednostavljuje aplikacijski kod (frontend/api

ne moraju upravljati certifikatima) dok i dalje osigurava šifriran promet

prema korisniku. Promet unutar clustera (router → pod) ide plain HTTP, što

je prihvatljivo unutar granica clustera zaštićenih NetworkPolicy

segmentacijom.



## Sigurnosni model — sažetak



- **Slika (image) sigurnost:** Trivy sken u CI/CD pipelineu, CRITICAL

  ranjivosti blokiraju push na registry (vidi `.github/workflows/ci.yml` i

  `docs/security/`)

- **Identitet:** namjenski ServiceAccount po komponenti, bez

  auto-montiranog K8s API tokena gdje nije potreban

- **Mrežna segmentacija:** default-deny NetworkPolicy baza, eksplicitna

  dopuštenja po komponenti prema principu najmanje potrebnog pristupa

- **Izolacija procesa:** proizvoljni, ne-root UID iz OpenShift `restricted`

  SCC raspona za sve podove, bez privilegiranih kontejnera

- **TLS:** obavezan HTTPS s automatskim redirectom na vanjskim Route-ovima

- **Tajne:** Postgres lozinka u Kubernetes Secret (napomena: trenutno je to

  demo/placeholder vrijednost prikladna za edukativni kontekst; produkcijski

  deployment bi trebao koristiti Vault ili External Secrets Operator umjesto

  YAML-a sa `stringData` commitanog u git)



## Poznata ograničenja i buduće nadogradnje



- Inicijalizacija Postgres sheme (`init.sql`) je trenutno ručni korak nakon

  prvog deploya — kandidat za automatizaciju kroz Kubernetes `Job` ili

  `initContainer`

- `Deployment` manifesti nemaju eksplicitan `securityContext` blok

  (`runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities.drop`) —

  trenutno ponašanje oslanja se prešutno na OpenShift `restricted` SCC

  default; eksplicitno deklariranje bilo bi dodatni sloj obrane i jasnija

  dokumentacija namjere

- `Deployment` image referenca je statička (`:latest`), bez `ImageChange`

  triggera na samom Deploymentu (za razliku od `DeploymentConfig`, obični

  `apps/v1 Deployment` nema to polje nativno) — trenutni tok zahtijeva

  ručni `oc rollout restart` nakon novog builda ako se želi trenutni deploy

  najnovije slike

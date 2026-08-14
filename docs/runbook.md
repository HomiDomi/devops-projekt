# Runbook — Secure Event Ticketing Platform (OpenShift)



Operativni vodič za deployment, health-check i troubleshooting aplikacije na

OpenShift clusteru. Namijenjen svakome tko preuzima ovaj sustav ili ga mora

obnoviti od nule.



## Preduvjeti



- Pristup OpenShift clusteru (`oc login`) i pravima u ciljanom namespaceu

- `oc` CLI instaliran

- Repozitorij kloniran lokalno (`git clone https://github.com/HomiDomi/devops-projekt`)

- Poznavanje namespacea u koji se deploya (u ovom projektu: `ticketing-app`)



```bash

oc login https://api.ocp4.example.com:6443 -u developer -p developer

oc project ticketing-app

```



Ako namespace ne postoji:



```bash

oc new-project ticketing-app

```



## Deployment redoslijed



Manifesti u `k8s/` su namjerno numerirani — redoslijed primjene je bitan jer

kasniji resursi ovise o ranijima (npr. Deploymenti trebaju ConfigMap/Secret

da već postoje, NetworkPolicy treba da podovi već imaju ispravne labele).



```bash

cd k8s/

oc apply -f 01-configmap.yaml

oc apply -f 02-secret.yaml

oc apply -f 03-postgres.yaml

oc apply -f 04-redis.yaml

```



Pričekaj da su Postgres i Redis `1/1 Running` prije nastavka:



```bash

oc get pods -n ticketing-app -w

```



```bash

oc apply -f 05-api.yaml

oc apply -f 06-worker.yaml

oc apply -f 07-frontend.yaml

```



BuildConfig triggeri automatski pokreću build pri `apply`. Pričekaj da svi

buildovi završe (`oc get builds`) prije nego očekuješ da podovi rade — prvi

pokušaj povlačenja image-a će pasti u kratki `ImagePullBackOff` dok build ne

završi; to je normalno i samoispravlja se.



```bash

oc apply -f 08-routes.yaml

oc apply -f 09-rbac.yaml

```



Nakon RBAC-a, poveži postojeće Deploymente s novim ServiceAccountima

(potrebno samo ako Deploymenti već postoje bez `serviceAccountName` u

manifestu):



```bash

oc patch deployment api -n ticketing-app -p '{"spec":{"template":{"spec":{"serviceAccountName":"api-sa"}}}}'

oc patch deployment worker -n ticketing-app -p '{"spec":{"template":{"spec":{"serviceAccountName":"worker-sa"}}}}'

oc patch deployment frontend -n ticketing-app -p '{"spec":{"template":{"spec":{"serviceAccountName":"frontend-sa"}}}}'

```



```bash

oc apply -f 10-networkpolicy.yaml

```



### Inicijalizacija baze podataka (obavezan ručni korak)



Za razliku od lokalnog Podman Compose okruženja (koji automatski učitava

`infra/postgres/init.sql` pri prvom pokretanju kontejnera), OpenShift

Postgres Deployment **ne** izvršava tu skriptu automatski. Mora se ručno

primijeniti jednom nakon prvog deploya:



```bash

cat infra/postgres/init.sql | oc exec -i $(oc get pod -l component=postgres -n ticketing-app -o jsonpath='{.items[0].metadata.name}') -n ticketing-app -- psql -U ticketing_user -d ticketing

```



Provjeri da je shema kreirana:



```bash

oc exec -it $(oc get pod -l component=postgres -n ticketing-app -o jsonpath='{.items[0].metadata.name}') -n ticketing-app -- psql -U ticketing_user -d ticketing -c '\dt'

```



Očekivan izlaz: tablica `ticket_orders`.



> **Napomena:** ovo je poznati manjak trenutnog setupa. Preporučena buduća

> nadogradnja je automatizirati ovaj korak kroz Kubernetes `Job` ili

> `initContainer` na Postgres Deploymentu, tako da se shema kreira sama pri

> prvom podizanju baze, bez ručne intervencije.



## Health check — potvrda da sve radi



```bash

oc get pods -n ticketing-app

```



Očekuje se `1/1 Running` za svih pet komponenti: `postgres`, `redis`, `api`,

`worker`, `frontend`.



```bash

oc get routes -n ticketing-app

```



Testiraj vanjski pristup (zamijeni hostname stvarnim iz izlaza iznad):



```bash

curl -k https://api-ticketing-app.apps.ocp4.example.com/healthz

curl -k https://frontend-ticketing-app.apps.ocp4.example.com

```



Testiraj cijeli lanac (frontend → api → redis → worker → postgres):



```bash

curl -k -X POST https://api-ticketing-app.apps.ocp4.example.com/tickets/purchase \

  -H "Content-Type: application/json" \

  -d '{"eventId":"evt-1001","customerEmail":"test@example.com","quantity":1}'

```



Očekivan odgovor: `{"message":"Order queued","orderId":"..."}`. Zatim

provjeri da je worker stvarno obradio narudžbu:



```bash

oc logs -l component=worker -n ticketing-app --tail=10

```



Očekuje se `Order processed` bez ijedne greške u zadnjih par redaka.



## Rollback



Za brzi povratak na prethodnu radnu verziju bilo koje komponente:



```bash

oc rollout undo deployment/api -n ticketing-app

oc rollout status deployment/api -n ticketing-app

```



Za povratak na specifičnu, poznatu reviziju:



```bash

oc rollout history deployment/api -n ticketing-app

oc rollout undo deployment/api -n ticketing-app --to-revision=<broj>

```



Isti obrazac vrijedi za `worker` i `frontend`.



## Poznati problemi i rješenja



Ova sekcija dokumentira stvarne probleme na koje smo naišli tijekom

postavljanja ovog sustava na OpenShift, s uzrokom i rješenjem — da ih idući

put ne treba ponovno otkrivati od nule.



### Postgres: `chmod: Operation not permitted`



**Uzrok:** javni `docker.io/library/postgres` image pretpostavlja fiksni

UID/GID i pokušava mijenjati vlasništvo data direktorija pri startu.

OpenShiftov `restricted` SCC dodjeljuje proizvoljni UID iz namespaceovog

raspona (u ovom clusteru `1000760000/10000`), pa `chmod`/`chown` operacije

koje image pokušava izvesti nemaju dozvolu.



**Rješenje:** koristi interni OpenShift ImageStream

`image-registry.openshift-image-registry.svc:5000/openshift/postgresql:15-el9`

(već zrcaljen u clusteru, dizajniran za rad s proizvoljnim UID-om). Env

varijable koriste prefiks `POSTGRESQL_*` (ne `POSTGRES_*`), data path je

`/var/lib/pgsql/data`, a probe moraju biti `tcpSocket` na port 5432 umjesto

`pg_isready` exec (jer alatni paket u ovom image-u ne uključuje isti CLI put).



### Redis: `MISCONF ... unable to persist to disk`



**Uzrok:** Redis periodički pokušava snimiti RDB snapshot na disk čak i bez

eksplicitnog `SAVE` poziva iz aplikacije. Bez definiranog PVC-a, `/data` je

obični container filesystem u vlasništvu root-a, a proizvoljni OpenShift UID

nema dozvolu pisanja. Redis zbog toga ulazi u zaštitni mod

(`stop-writes-on-bgsave-error`) i blokira sve write naredbe — što u praksi

znači da worker ne može ni čitati ni brisati iz queuea.



**Rješenje:** budući da Redis ovdje služi samo kao efemerni queue/cache (ne

kao trajna pohrana — to je posao Postgresa), isključi RDB snapshotting

potpuno umjesto rješavati PVC/permisije:



```yaml

command: ["redis-server", "--appendonly", "no", "--save", ""]

```



### NetworkPolicy: DNS razrješavanje ne radi (`getaddrinfo EAI_AGAIN`)



**Uzrok:** OpenShiftov interni CoreDNS (`openshift-dns` namespace) sluša na

portu **5353** unutar samog poda — Service `dns-default` samo prevodi

vanjski port 53 na taj interni 5353. NetworkPolicy egress pravila se

evaluiraju **nakon** tog prijevoda, na stvarnom pod IP:portu, pa pravilo

koje dopušta port 53 nikad ne pogađa stvarnu DNS destinaciju.



**Rješenje:** DNS egress pravilo mora ciljati port 5353, ne 53:



```yaml

egress:

  - to:

      - namespaceSelector:

          matchLabels:

            kubernetes.io/metadata.name: openshift-dns

        podSelector:

          matchLabels:

            dns.operator.openshift.io/daemonset-dns: default

    ports:

      - protocol: UDP

        port: 5353

      - protocol: TCP

        port: 5353

```



`kubernetes.io/metadata.name` je automatska labela na svakom namespaceu od

Kubernetesa 1.21+ — ne treba posebnu dozvolu za čitanje `openshift-dns`

namespacea da bi je se referenciralo u policy-ju.



### RBAC: `serviceaccount "api-sa" not found` nakon patcha



**Uzrok:** Deployment je patchan da koristi novi ServiceAccount prije nego

je taj ServiceAccount stvarno kreiran u clusteru (npr. `09-rbac.yaml` nije

uspješno primijenjen prije patcha).



**Rješenje:** provjeri `oc get sa -n <namespace>` prije patchanja Deploymenta.

Ako je do ovoga već došlo, primijeni `09-rbac.yaml` — deployment-controller

automatski retry-a stvaranje čekajućih podova čim ServiceAccount postane

dostupan, bez potrebe za dodatnim `rollout restart`.



### GHCR push: `repository name must be lowercase`



**Uzrok:** Docker/OCI registry nazivi moraju biti isključivo mala slova.

`github.repository_owner` u GitHub Actions vraća naziv organizacije/korisnika

točno onako kako je upisan (npr. `HomiDomi`), s velikim slovima.



**Rješenje:** pretvori vlasnika u mala slova prije korištenja u tagu:



```yaml

- run: echo "IMAGE_OWNER=$(echo '${{ github.repository_owner }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_ENV"

```



### GitHub push odbijen: `refusing to allow a Personal Access Token ... without workflow scope`



**Uzrok:** GitHub posebno štiti `.github/workflows/` direktorij — token bez

eksplicitnog `workflow` scopea ne smije mijenjati CI konfiguraciju, čak i uz

puni `repo` scope.



**Rješenje:** GitHub → Settings → Developer settings → Personal access

tokens → dodaj `workflow` scope na postojeći token (ili generiraj novi s tim

scopeom uključenim).



## Kontakti / vlasništvo



Ovaj runbook prati stanje projekta na datum zadnje izmjene. Za pitanja o

arhitekturnim odlukama, vidi `docs/architecture.md`.

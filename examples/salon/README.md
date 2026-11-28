# Salon example catalog

The pilot numbered the salon’s services and staff separately, starting at 1 in fixture order. Both agents need the same catalog. The norm checks that the reply repeats the requested IDs. The salon looks up the services and determines the price.

## Asking about an add-on

A guest asks how much deep conditioning costs alone or with a blowout. Look up deep conditioning under add-ons (22) and blowout under primary services (5). Send the following client message.

```lisp
(ask-prices :norm salon-addon-prices :addon 22 :companion 5)
```

The server replies to that message with the two prices for deep conditioning. In this fixture it costs $40 alone or $20 with the blowout. The blowout has its own charge.

```lisp
(line-prices :norm salon-addon-prices :addon 22 :companion 5 :standalone-cents 4000 :with-companion-cents 2000)
```

## Service IDs

Use a primary service for `companion` and an add-on for `addon`. Both use the same numbering as `service`.

| ID | Service | Kind |
| ---: | --- | --- |
| 1 | Women's cut & style | Primary |
| 2 | Men's cut | Primary |
| 3 | Kids' cut (under 12) | Primary |
| 4 | Bang trim | Primary |
| 5 | Blowout | Primary |
| 6 | Updo / event styling | Primary |
| 7 | Single-process color | Primary |
| 8 | Root touch-up | Primary |
| 9 | Full highlights | Primary |
| 10 | Balayage | Primary |
| 11 | Color correction | Primary |
| 12 | Keratin smoothing treatment | Primary |
| 13 | Skin fade | Primary |
| 14 | Hot-towel shave | Primary |
| 15 | Classic facial | Primary |
| 16 | Brow wax & shape | Primary |
| 17 | Classic manicure | Primary |
| 18 | Classic pedicure | Primary |
| 19 | Gel manicure | Primary |
| 20 | Gloss treatment | Add-on |
| 21 | Toner | Add-on |
| 22 | Deep conditioning | Add-on |
| 23 | Olaplex bond treatment | Add-on |
| 24 | Scalp massage | Add-on |
| 25 | Blowout finish | Add-on |
| 26 | Beard trim | Add-on |
| 27 | Brow tint | Add-on |
| 28 | Nail art (per set) | Add-on |
| 29 | Paraffin dip | Add-on |

## Staff IDs

| ID | Staff member |
| ---: | --- |
| 1 | Ava Moreno |
| 2 | Jonah Patel |
| 3 | Priya Raman |
| 4 | Lena Okoro |
| 5 | Theo Grant |
| 6 | Marco Diaz |
| 7 | Sofia Lind |
| 8 | Kim Nguyen |

## Other numbers

- `appointment` identifies a particular booking in the guest’s appointment records. `ticket` is the reference the salon returns when it creates a handoff.
- `basis` identifies the personal discount: 0 for none, 1 for first visit, 2 for birthday, 3 for VIP.
- `issue` identifies the reminder problem: 1 for losing access to the old phone, 2 for missing reminders, 3 for help changing the reminder method.
- `weekday` runs from 1 (Monday) to 7 (Sunday). Opening and closing times count minutes from local midnight. All fields ending in `-cents` use cents.

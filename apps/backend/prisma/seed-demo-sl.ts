/**
 * Demo seed za slovenskega čebelarja – čebelnjak "Griblje ob Kolpi".
 * Zagon (po prvem zagonu aplikacije ali samostojno):
 *   cd apps/backend && pnpm dlx tsx prisma/seed-demo-sl.ts
 * Prijava: demo@cebele.si / cebela123
 */
import { PrismaClient } from '@/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from 'better-auth/crypto';
import { randomUUID } from 'crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const day = (n: number) => new Date(Date.now() + n * 86400000);

async function main() {
  // počisti morebitne prejšnje demo podatke (prepozna po e-pošti)
  const old = await prisma.user.findUnique({ where: { email: 'demo@cebele.si' } });
  if (old) {
    await prisma.apiary.deleteMany({ where: { userId: old.id } });
    await prisma.account.deleteMany({ where: { userId: old.id } });
    await prisma.user.delete({ where: { id: old.id } });
  }

  const user = await prisma.user.create({
    data: { email: 'demo@cebele.si', name: 'Demo Čebelar', emailVerified: true },
  });
  await prisma.account.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: await hashPassword('cebela123'),
    },
  });

  const apiary = await prisma.apiary.create({
    data: {
      name: 'Griblje ob Kolpi',
      location: 'Griblje 70, Bela krajina',
      latitude: 45.5735782,
      longitude: 15.295151,
      notes: 'Domači čebelnjak ob reki Kolpi – demo podatki za preizkus aplikacije.',
      userId: user.id,
    },
  });

  const [k1, k2, k3] = await Promise.all([
    prisma.hive.create({
      data: {
        name: 'Kolpa 1', apiaryId: apiary.id, status: 'ACTIVE',
        installationDate: new Date('2023-04-10'), positionRow: 0, positionCol: 0,
        notes: 'Najmočnejša družina, redno daje medišča.',
        boxes: {
          create: [
            { position: 1, frameCount: 10, maxFrameCount: 10, type: 'BROOD', variant: 'LANGSTROTH_DEEP' },
            { position: 2, frameCount: 10, maxFrameCount: 10, type: 'HONEY', variant: 'LANGSTROTH_SHALLOW', hasExcluder: true },
          ],
        },
      },
    }),
    prisma.hive.create({
      data: {
        name: 'Kolpa 2', apiaryId: apiary.id, status: 'ACTIVE',
        installationDate: new Date('2024-05-02'), positionRow: 0, positionCol: 1,
        boxes: { create: [{ position: 1, frameCount: 10, maxFrameCount: 10, type: 'BROOD', variant: 'LANGSTROTH_DEEP' }] },
      },
    }),
    prisma.hive.create({
      data: {
        name: 'Kolpa 3', apiaryId: apiary.id, status: 'ACTIVE',
        installationDate: new Date('2025-04-20'), positionRow: 0, positionCol: 2,
        notes: 'Lani rojil – pozornost pri spomladanskih pregledih.',
        boxes: {
          create: [
            { position: 1, frameCount: 10, maxFrameCount: 10, type: 'BROOD', variant: 'LANGSTROTH_DEEP' },
            { position: 2, frameCount: 10, maxFrameCount: 10, type: 'FEEDER' },
          ],
        },
      },
    }),
  ]);

  await prisma.queen.createMany({
    data: [
      { hiveId: k1.id, color: 'YELLOW', year: 2024, marking: 'K-24', source: 'Lastna vzreja', status: 'ACTIVE', installedAt: new Date('2024-06-01') },
      { hiveId: k2.id, color: 'BLUE', year: 2023, marking: 'K-23', source: 'ČZS – vzrejni program', status: 'ACTIVE', installedAt: new Date('2023-07-15') },
    ],
  });

  const i1 = await prisma.inspection.create({
    data: {
      hiveId: k1.id, date: day(-160), status: 'COMPLETED', temperature: 18, weatherConditions: 'Sunny',
      overallScore: 8, populationScore: 8, storesScore: 7, queenScore: 9, createdByUserId: user.id,
      observations: {
        createMany: {
          data: [
            { type: 'QUEEN_SEEN', numericValue: 1, notes: 'Matica opažena na 3. satu.' },
            { type: 'BROOD_COUNT', numericValue: 8, notes: 'Sklenjen vzorec zalege, brez matičnjakov.' },
          ],
        },
      },
      notes: { create: [{ text: 'Zgodnji spomladanski razvoj odličen – ob naslednjem pregledu dodam medišče.' }] },
    },
  });

  await prisma.inspection.create({
    data: {
      hiveId: k1.id, date: day(-110), status: 'COMPLETED', temperature: 26, weatherConditions: 'Sunny',
      overallScore: 9, populationScore: 9, storesScore: 8, queenScore: 9, createdByUserId: user.id,
      observations: {
        createMany: {
          data: [
            { type: 'QUEEN_SEEN', numericValue: 1, notes: 'Matica zalega v polnem obsegu.' },
            { type: 'BROOD_COUNT', numericValue: 10, notes: 'Polno plodišče, dodano medišče.' },
          ],
        },
      },
    },
  });

  await prisma.inspection.create({
    data: {
      hiveId: k2.id, date: day(-110), status: 'COMPLETED', temperature: 26, weatherConditions: 'PartlyCloudy',
      overallScore: 7, populationScore: 7, storesScore: 7, queenScore: 8, createdByUserId: user.id,
      observations: {
        createMany: {
          data: [
            { type: 'QUEEN_SEEN', numericValue: 1, notes: 'Matica opažena, zalega nekoliko razpršena.' },
            { type: 'BROOD_COUNT', numericValue: 7, notes: 'Solidno, zaostaja za Kolpo 1.' },
          ],
        },
      },
    },
  });

  await prisma.inspection.create({
    data: {
      hiveId: k3.id, date: day(-110), status: 'COMPLETED', temperature: 26, weatherConditions: 'Sunny',
      overallScore: 5, populationScore: 6, storesScore: 6, queenScore: 3, createdByUserId: user.id,
      observations: {
        createMany: {
          data: [
            { type: 'QUEEN_SEEN', numericValue: 0, notes: 'Matice ni bilo videti.' },
            { type: 'BROOD_COUNT', numericValue: 4, notes: 'Najdeni rojilni matičnjaki na spodnjih robovih!' },
          ],
        },
      },
      notes: { create: [{ text: 'Nujna kontrola čez 7 dni – izrezati rojilne matičnjake ali izvesti delitev.' }] },
    },
  });

  await prisma.inspection.create({
    data: { hiveId: k1.id, date: day(6), status: 'SCHEDULED', isAllDay: true },
  });

  // ukrepi: krmljenje, zdravljenje
  await prisma.action.create({
    data: {
      hiveId: k3.id, type: 'FEEDING', date: new Date('2025-09-10'), createdByUserId: user.id,
      notes: 'Jesensko krmljenje po zadnjem pregledu.',
      feedingAction: { create: { feedType: 'Sugar Syrup', amount: 3, unit: 'l', concentration: '2:1' } },
    },
  });
  for (const h of [k1, k2, k3]) {
    await prisma.action.create({
      data: {
        hiveId: h.id, type: 'TREATMENT', date: new Date('2025-12-05'), createdByUserId: user.id,
        notes: 'Zimsko odkapljanje z oksalno kislino (brezzalegno stanje).',
        treatmentAction: { create: { product: 'Oksalna kislina 3,5 %', quantity: 50, unit: 'ml' } },
      },
    });
  }

  // pridelek julij
  const harvest = await prisma.harvest.create({
    data: {
      apiaryId: apiary.id, date: day(-70), status: 'COMPLETED', totalWeight: 21, totalWeightUnit: 'kg',
      notes: 'Lipov in gozdni med, točeno v enem dnevu.',
      harvestHives: {
        create: [
          { hiveId: k1.id, framesTaken: 8, honeyAmount: 12, honeyPercentage: 57.1 },
          { hiveId: k2.id, framesTaken: 6, honeyAmount: 9, honeyPercentage: 42.9 },
        ],
      },
    },
  });
  await prisma.action.createMany({
    data: [
      { hiveId: k1.id, harvestId: harvest.id, type: 'HARVEST', date: day(-70), notes: 'Posneto 8 satov.' },
      { hiveId: k2.id, harvestId: harvest.id, type: 'HARVEST', date: day(-70), notes: 'Posneto 6 satov.' },
    ],
  });
  await prisma.harvestAction.createMany({
    data: [
      { actionId: (await prisma.action.findFirst({ where: { harvestId: harvest.id, hiveId: k1.id } }))!.id, amount: 12, unit: 'kg' },
      { actionId: (await prisma.action.findFirst({ where: { harvestId: harvest.id, hiveId: k2.id } }))!.id, amount: 9, unit: 'kg' },
    ],
  });

  // opravila
  await prisma.todo.createMany({
    data: [
      { apiaryId: apiary.id, hiveId: k3.id, title: 'Kontrola rojilnih matičnjakov – Kolpa 3', dueDate: day(3), description: 'Pregledati spodnje robove satov in izrezati matičnjake ali izvesti delitev.' },
      { apiaryId: apiary.id, title: 'Naročiti sate in osnove za naslednjo sezono', dueDate: day(20) },
      { apiaryId: apiary.id, title: 'Počistiti in pospraviti medišča po točenju', completed: true },
    ],
  });

  console.log('✅ Demo podatki ustvarjeni: prijava demo@cebele.si / cebela123');
  console.log('   Čebelnjak "Griblje ob Kolpi": 3 panji, 2 matici, 5 pregledov (1 načrtovan), 5 ukrepov, pridelek 21 kg, 3 opravila.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect().then(() => process.exit()).catch(() => process.exit(1)));

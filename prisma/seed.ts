import bcrypt from 'bcrypt'
import prisma from '../lib/prisma'

async function main() {
  console.log('🌱 Start seeding...')

  //
  // 1️⃣ CHECKPOINTS
  //
  await prisma.checkpoint.createMany({
    data: [
      { code: "HQ-1", type: 'HQ', name: 'Headquarters' },
      { code: "DC-1", type: 'DC', name: 'Distribution Center Jakarta' },
      { code: "ST-1", type: 'STORE', name: 'Store Jakarta' },
    ],
    skipDuplicates: true,
  })

  console.log('✅ Checkpoints seeded')

  //
  // 2️⃣ ACCESS MODULES
  //
  await prisma.access.createMany({
    data: [
      { name: 'Dashboard', description: 'View dashboard', code: '1001' },
      { name: 'Cards', description: 'Manage ICCID cards', code: '1002' },
      { name: 'Numbers', description: 'Manage MSISDN numbers', code: '1003' },
      { name: 'Distribution', description: 'Handle distribution', code: '1004' },
      { name: 'Stock Opname', description: 'Stock reconciliation', code: '1005' },
      { name: 'Reports', description: 'View reports', code: '1006' },
    ],
    skipDuplicates: true,
  })

  console.log('✅ Access modules seeded')

  //
  // 3️⃣ USERS
  //
  const adminPassword = await bcrypt.hash('admin123', 10)
  const staffPassword = await bcrypt.hash('staff123', 10)

  const admin = await prisma.user.upsert({
    where: { code: 'ADMIN' },
    update: {},
    create: {
      name: 'Super Admin',
      code: 'ADMIN',
      phone: '08000000001',
      password: adminPassword,
    },
  })

  const staff = await prisma.user.upsert({
    where: { code: 'STAFF01' },
    update: {},
    create: {
      name: 'Staff User',
      code: 'STAFF01',
      phone: '08000000002',
      password: staffPassword,
    },
  })

  console.log('✅ Users seeded')

  //
  // 4️⃣ PERMISSIONS
  //
  const allAccess = await prisma.access.findMany()

  // ADMIN gets full access
  for (const access of allAccess) {
    await prisma.permission.upsert({
      where: {
        userCode_accessCode: {
          userCode: admin.code,
          accessCode: access.code,
        },
      },
      update: {},
      create: {
        userCode: admin.code,
        accessCode: access.code,
        status: true,
      },
    })
  }

  // STAFF limited access
  const staffAccessCodes = ['1001', '1002', '1004']

  for (const accessCode of staffAccessCodes) {
    await prisma.permission.upsert({
      where: {
        userCode_accessCode: {
          userCode: staff.code,
          accessCode: accessCode,
        },
      },
      update: {},
      create: {
        userCode: staff.code,
        accessCode: accessCode,
        status: true,
      },
    })
  }

  console.log('✅ Permissions assigned')

  console.log('🎉 Seeding completed successfully')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
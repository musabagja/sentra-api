"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma_1 = __importDefault(require("../lib/prisma"));
async function main() {
    console.log('🌱 Start seeding...');
    //
    // 1️⃣ CHECKPOINTS
    //
    await prisma_1.default.checkpoint.createMany({
        data: [
            { code: 'HQ01', type: 'HQ', name: 'Headquarters' },
            { code: 'ST01', type: 'STORE', name: 'Store 01' },
            { code: 'DC01', type: 'DC', name: 'Distribution Center 01' },
            { code: 'DC02', type: 'DC', name: 'Distribution Center 02' },
            { code: 'DC03', type: 'DC', name: 'Distribution Center 03' },
            { code: 'DC04', type: 'DC', name: 'Distribution Center 04' },
            { code: 'DC05', type: 'DC', name: 'Distribution Center 05' },
            { code: 'DC06', type: 'DC', name: 'Distribution Center 06' },
            { code: 'DC07', type: 'DC', name: 'Distribution Center 07' },
            { code: 'DC08', type: 'DC', name: 'Distribution Center 08' },
            { code: 'DC09', type: 'DC', name: 'Distribution Center 09' },
            { code: 'DC10', type: 'DC', name: 'Distribution Center 10' },
        ],
        skipDuplicates: true,
    });
    console.log('✅ Checkpoints seeded');
    //
    // 2️⃣ ACCESS MODULES
    //
    await prisma_1.default.access.createMany({
        data: [
            { name: 'Dashboard', description: 'View dashboard', code: '1001' },
            { name: 'Cards', description: 'Manage ICCID cards', code: '1002' },
            { name: 'Numbers', description: 'Manage MSISDN numbers', code: '1003' },
            { name: 'Distribution', description: 'Handle distribution', code: '1004' },
            { name: 'Stock Opname', description: 'Stock reconciliation', code: '1005' },
            { name: 'Reports', description: 'View reports', code: '1006' },
        ],
        skipDuplicates: true,
    });
    console.log('✅ Access modules seeded');
    //
    // 3️⃣ CIRCLES
    //
    const hqCircle = await prisma_1.default.circle.upsert({
        where: { code: 'CIRCLE-HQ' },
        update: {},
        create: { name: 'HQ Circle', code: 'CIRCLE-HQ', status: 'ACTIVE' },
    });
    const storeCircle = await prisma_1.default.circle.upsert({
        where: { code: 'CIRCLE-STORE' },
        update: {},
        create: { name: 'Store Circle', code: 'CIRCLE-STORE', status: 'ACTIVE' },
    });
    const dcCircle = await prisma_1.default.circle.upsert({
        where: { code: 'CIRCLE-DC' },
        update: {},
        create: { name: 'DC Circle', code: 'CIRCLE-DC', status: 'ACTIVE' },
    });
    console.log('✅ Circles seeded');
    //
    // 4️⃣ CHECKPOINT-CIRCLE MAPPINGS
    //
    const dcCodes = ['DC01', 'DC02', 'DC03', 'DC04', 'DC05', 'DC06', 'DC07', 'DC08', 'DC09', 'DC10'];
    // HQ circle sees HQ + all DCs
    const hqMappings = [
        { circleCode: hqCircle.code, checkpointCode: 'HQ01' },
        ...dcCodes.map(code => ({ circleCode: hqCircle.code, checkpointCode: code })),
    ];
    // Store circle sees STORE + all DCs
    const storeMappings = [
        { circleCode: storeCircle.code, checkpointCode: 'ST01' },
        ...dcCodes.map(code => ({ circleCode: storeCircle.code, checkpointCode: code })),
    ];
    // DC circle sees all DCs only
    const dcMappings = dcCodes.map(code => ({ circleCode: dcCircle.code, checkpointCode: code }));
    await prisma_1.default.checkpointCircle.createMany({
        data: [...hqMappings, ...storeMappings, ...dcMappings],
        skipDuplicates: true,
    });
    console.log('✅ Checkpoint-circle mappings seeded');
    //
    // 5️⃣ USERS
    //
    const adminPassword = await bcrypt_1.default.hash('admin123', 10);
    const staffPassword = await bcrypt_1.default.hash('staff123', 10);
    const admin = await prisma_1.default.user.upsert({
        where: { code: 'ADMIN' },
        update: {},
        create: {
            name: 'Super Admin',
            code: 'ADMIN',
            phone: '08000000001',
            password: adminPassword,
            circleCode: hqCircle.code,
        },
    });
    const staff = await prisma_1.default.user.upsert({
        where: { code: 'STAFF01' },
        update: {},
        create: {
            name: 'Staff User',
            code: 'STAFF01',
            phone: '08000000002',
            password: staffPassword,
            circleCode: dcCircle.code,
        },
    });
    console.log('✅ Users seeded');
    //
    // 6️⃣ PERMISSIONS
    //
    const allAccess = await prisma_1.default.access.findMany();
    for (const access of allAccess) {
        await prisma_1.default.permission.upsert({
            where: { userCode_accessCode: { userCode: admin.code, accessCode: access.code } },
            update: {},
            create: { userCode: admin.code, accessCode: access.code, status: true },
        });
    }
    const staffAccessCodes = ['1001', '1002', '1004'];
    for (const accessCode of staffAccessCodes) {
        await prisma_1.default.permission.upsert({
            where: { userCode_accessCode: { userCode: staff.code, accessCode: accessCode } },
            update: {},
            create: { userCode: staff.code, accessCode: accessCode, status: true },
        });
    }
    console.log('✅ Permissions assigned');
    console.log('🎉 Seeding completed successfully');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma_1.default.$disconnect();
});

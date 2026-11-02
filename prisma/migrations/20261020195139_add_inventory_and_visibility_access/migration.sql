BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[InventoryItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000) NOT NULL,
    [category] NVARCHAR(1000),
    [minimumStock] INT NOT NULL CONSTRAINT [InventoryItem_minimumStock_df] DEFAULT 1,
    [stock] INT NOT NULL CONSTRAINT [InventoryItem_stock_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InventoryItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [InventoryItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[InventoryTransaction] (
    [id] INT NOT NULL IDENTITY(1,1),
    [code] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [date] DATETIME2 NOT NULL,
    [note] NVARCHAR(1000),
    [receivedFrom] NVARCHAR(1000),
    [recipientType] NVARCHAR(1000),
    [recipientName] NVARCHAR(1000),
    [proofURL] NVARCHAR(1000),
    [handoverPhotoURL] NVARCHAR(1000),
    [handoverSignURL] NVARCHAR(1000),
    [handoverLat] FLOAT(53),
    [handoverLng] FLOAT(53),
    [handedOverAt] DATETIME2,
    [userCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InventoryTransaction_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [InventoryTransaction_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InventoryTransaction_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[InventoryTransactionItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [transactionID] INT NOT NULL,
    [itemID] INT NOT NULL,
    [qty] INT NOT NULL,
    [stockAfter] INT NOT NULL,
    CONSTRAINT [InventoryTransactionItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryTransaction_type_idx] ON [dbo].[InventoryTransaction]([type]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryTransaction_date_idx] ON [dbo].[InventoryTransaction]([date]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryTransactionItem_transactionID_idx] ON [dbo].[InventoryTransactionItem]([transactionID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InventoryTransactionItem_itemID_idx] ON [dbo].[InventoryTransactionItem]([itemID]);

-- AddForeignKey
ALTER TABLE [dbo].[InventoryTransaction] ADD CONSTRAINT [InventoryTransaction_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryTransactionItem] ADD CONSTRAINT [InventoryTransactionItem_transactionID_fkey] FOREIGN KEY ([transactionID]) REFERENCES [dbo].[InventoryTransaction]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryTransactionItem] ADD CONSTRAINT [InventoryTransactionItem_itemID_fkey] FOREIGN KEY ([itemID]) REFERENCES [dbo].[InventoryItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Seed: hak akses grup "Visibility" (V-01) — nama grup = kolom description, mengikuti pola JD01/JD03
IF NOT EXISTS (SELECT 1 FROM [dbo].[Access] WHERE [code] = N'V01')
    INSERT INTO [dbo].[Access] ([code], [name], [description]) VALUES (N'V01', N'Akses Menu', N'Visibility');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Access] WHERE [code] = N'V02')
    INSERT INTO [dbo].[Access] ([code], [name], [description]) VALUES (N'V02', N'Serah Terima', N'Visibility');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

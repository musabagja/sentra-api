BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Checkpoint] (
    [id] INT NOT NULL IDENTITY(1,1),
    [code] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Checkpoint_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Checkpoint_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Checkpoint_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Card] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000),
    [key] NVARCHAR(1000) NOT NULL,
    [checkpointCode] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Card_status_df] DEFAULT 'UNVERIFIED',
    [remark] NVARCHAR(1000),
    [batchCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Card_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [validatedAt] DATETIME2,
    CONSTRAINT [Card_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Card_key_key] UNIQUE NONCLUSTERED ([key])
);

-- CreateTable
CREATE TABLE [dbo].[Number] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000),
    [key] NVARCHAR(1000) NOT NULL,
    [checkpointCode] NVARCHAR(1000),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Number_status_df] DEFAULT 'VERIFIED',
    [remark] NVARCHAR(1000),
    [batchCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Number_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Number_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Number_key_key] UNIQUE NONCLUSTERED ([key])
);

-- CreateTable
CREATE TABLE [dbo].[UploadBatch] (
    [id] INT NOT NULL IDENTITY(1,1),
    [code] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000),
    [userCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [UploadBatch_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [UploadBatch_status_df] DEFAULT 'ONGOING',
    [total] INT NOT NULL CONSTRAINT [UploadBatch_total_df] DEFAULT 0,
    [note] NVARCHAR(1000),
    CONSTRAINT [UploadBatch_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UploadBatch_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[UploadBatchProgress] (
    [id] INT NOT NULL IDENTITY(1,1),
    [batchCode] NVARCHAR(1000) NOT NULL,
    [progress] INT NOT NULL CONSTRAINT [UploadBatchProgress_progress_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [UploadBatchProgress_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [UploadBatchProgress_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Merge] (
    [id] INT NOT NULL IDENTITY(1,1),
    [numberKey] NVARCHAR(1000) NOT NULL,
    [cardKey] NVARCHAR(1000) NOT NULL,
    [remark] NVARCHAR(1000),
    [checkpointCode] NVARCHAR(1000),
    [userCode] NVARCHAR(1000) NOT NULL,
    [TRN] NVARCHAR(1000),
    [soldAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Merge_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [verifiedAt] DATETIME2,
    CONSTRAINT [Merge_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Merge_numberKey_key] UNIQUE NONCLUSTERED ([numberKey]),
    CONSTRAINT [Merge_cardKey_key] UNIQUE NONCLUSTERED ([cardKey])
);

-- CreateTable
CREATE TABLE [dbo].[MergeAdditional] (
    [id] INT NOT NULL IDENTITY(1,1),
    [numberKey] NVARCHAR(1000) NOT NULL,
    [cardKey] NVARCHAR(1000) NOT NULL,
    [remark] NVARCHAR(1000),
    [checkpointCode] NVARCHAR(1000),
    [userCode] NVARCHAR(1000) NOT NULL,
    [TRN] NVARCHAR(1000),
    [type] NVARCHAR(1000),
    [soldAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [MergeAdditional_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [verifiedAt] DATETIME2,
    CONSTRAINT [MergeAdditional_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [MergeAdditional_numberKey_key] UNIQUE NONCLUSTERED ([numberKey]),
    CONSTRAINT [MergeAdditional_cardKey_key] UNIQUE NONCLUSTERED ([cardKey])
);

-- CreateTable
CREATE TABLE [dbo].[CardStock] (
    [id] INT NOT NULL IDENTITY(1,1),
    [checkpointCode] NVARCHAR(1000) NOT NULL,
    [amount] INT NOT NULL,
    [updatedAt] DATETIME2 NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CardStock_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CardStock_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CardMovement] (
    [id] INT NOT NULL IDENTITY(1,1),
    [cardID] INT NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [sourceCode] NVARCHAR(1000),
    [targetCode] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CardMovement_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CardMovement_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[NumberMovement] (
    [id] INT NOT NULL IDENTITY(1,1),
    [numberID] INT NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [sourceCode] NVARCHAR(1000),
    [targetCode] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [NumberMovement_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [NumberMovement_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Distribution] (
    [id] INT NOT NULL IDENTITY(1,1),
    [sourceCode] NVARCHAR(1000) NOT NULL,
    [targetCode] NVARCHAR(1000) NOT NULL,
    [batch] NVARCHAR(1000),
    [amount] INT NOT NULL,
    [status] NVARCHAR(1000) NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [scheduledAt] DATETIME2,
    [completedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Distribution_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Distribution_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DistributionSubmittance] (
    [id] INT NOT NULL IDENTITY(1,1),
    [distributionID] INT NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [longitude] FLOAT(53),
    [latitude] FLOAT(53),
    [signURL] NVARCHAR(1000),
    [imageURL] NVARCHAR(1000),
    [storeURL] NVARCHAR(1000),
    [note] NVARCHAR(1000),
    [recipientName] NVARCHAR(1000),
    [recipientURL] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DistributionSubmittance_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DistributionSubmittance_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DistributionSubmittance_distributionID_key] UNIQUE NONCLUSTERED ([distributionID])
);

-- CreateTable
CREATE TABLE [dbo].[DistributionItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [itemKey] NVARCHAR(1000) NOT NULL,
    [distributionID] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DistributionItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DistributionItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Opname] (
    [id] INT NOT NULL IDENTITY(1,1),
    [amount] INT NOT NULL,
    [progress] INT NOT NULL,
    [batch] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [checkpointCode] NVARCHAR(1000) NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Opname_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Opname_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OpnameSubmittance] (
    [id] INT NOT NULL IDENTITY(1,1),
    [opnameID] INT NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [signURL] NVARCHAR(1000),
    [picSignURL] NVARCHAR(1000),
    [picName] NVARCHAR(1000),
    [documentationURL] NVARCHAR(1000),
    [note] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OpnameSubmittance_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OpnameSubmittance_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [OpnameSubmittance_opnameID_key] UNIQUE NONCLUSTERED ([opnameID])
);

-- CreateTable
CREATE TABLE [dbo].[OpnameSubmittanceDocumentation] (
    [id] INT NOT NULL IDENTITY(1,1),
    [submittanceID] INT NOT NULL,
    [url] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OpnameSubmittanceDocumentation_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OpnameSubmittanceDocumentation_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OpnameUpdate] (
    [id] INT NOT NULL IDENTITY(1,1),
    [itemID] INT NOT NULL,
    [status] NVARCHAR(1000) NOT NULL,
    [opnameID] INT NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OpnameUpdate_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OpnameUpdate_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[User] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000) NOT NULL,
    [code] NVARCHAR(1000) NOT NULL,
    [phone] NVARCHAR(1000) NOT NULL,
    [imageURL] NVARCHAR(1000),
    [password] NVARCHAR(1000),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [User_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [User_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [circleCode] NVARCHAR(1000) NOT NULL,
    CONSTRAINT [User_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [User_code_key] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [User_phone_key] UNIQUE NONCLUSTERED ([phone])
);

-- CreateTable
CREATE TABLE [dbo].[Access] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000) NOT NULL,
    [description] NVARCHAR(1000),
    [code] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Access_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Access_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Access_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Permission] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userCode] NVARCHAR(1000) NOT NULL,
    [accessCode] NVARCHAR(1000) NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [Permission_status_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Permission_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Permission_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Permission_userCode_accessCode_key] UNIQUE NONCLUSTERED ([userCode],[accessCode])
);

-- CreateTable
CREATE TABLE [dbo].[Session] (
    [id] NVARCHAR(1000) NOT NULL,
    [userCode] NVARCHAR(1000) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Session_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Session_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Circle] (
    [id] INT NOT NULL IDENTITY(1,1),
    [name] NVARCHAR(1000) NOT NULL,
    [code] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Circle_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Circle_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Circle_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Circle_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[CheckpointCircle] (
    [id] INT NOT NULL IDENTITY(1,1),
    [checkpointCode] NVARCHAR(1000) NOT NULL,
    [circleCode] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CheckpointCircle_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CheckpointCircle_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CheckpointCircle_checkpointCode_circleCode_key] UNIQUE NONCLUSTERED ([checkpointCode],[circleCode])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Card_batchCode_idx] ON [dbo].[Card]([batchCode]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Card_checkpointCode_idx] ON [dbo].[Card]([checkpointCode]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Card_status_idx] ON [dbo].[Card]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Number_batchCode_idx] ON [dbo].[Number]([batchCode]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Number_checkpointCode_idx] ON [dbo].[Number]([checkpointCode]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Number_status_idx] ON [dbo].[Number]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Merge_soldAt_idx] ON [dbo].[Merge]([soldAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [MergeAdditional_soldAt_idx] ON [dbo].[MergeAdditional]([soldAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CardStock_checkpointCode_idx] ON [dbo].[CardStock]([checkpointCode]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CardMovement_cardID_idx] ON [dbo].[CardMovement]([cardID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CardMovement_createdAt_idx] ON [dbo].[CardMovement]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [NumberMovement_numberID_idx] ON [dbo].[NumberMovement]([numberID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [NumberMovement_createdAt_idx] ON [dbo].[NumberMovement]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DistributionSubmittance_distributionID_idx] ON [dbo].[DistributionSubmittance]([distributionID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DistributionItem_distributionID_idx] ON [dbo].[DistributionItem]([distributionID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OpnameUpdate_itemID_idx] ON [dbo].[OpnameUpdate]([itemID]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Session_userCode_idx] ON [dbo].[Session]([userCode]);

-- AddForeignKey
ALTER TABLE [dbo].[Card] ADD CONSTRAINT [Card_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Card] ADD CONSTRAINT [Card_batchCode_fkey] FOREIGN KEY ([batchCode]) REFERENCES [dbo].[UploadBatch]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Number] ADD CONSTRAINT [Number_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Number] ADD CONSTRAINT [Number_batchCode_fkey] FOREIGN KEY ([batchCode]) REFERENCES [dbo].[UploadBatch]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UploadBatch] ADD CONSTRAINT [UploadBatch_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[UploadBatchProgress] ADD CONSTRAINT [UploadBatchProgress_batchCode_fkey] FOREIGN KEY ([batchCode]) REFERENCES [dbo].[UploadBatch]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Merge] ADD CONSTRAINT [Merge_cardKey_fkey] FOREIGN KEY ([cardKey]) REFERENCES [dbo].[Card]([key]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Merge] ADD CONSTRAINT [Merge_numberKey_fkey] FOREIGN KEY ([numberKey]) REFERENCES [dbo].[Number]([key]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Merge] ADD CONSTRAINT [Merge_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Merge] ADD CONSTRAINT [Merge_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MergeAdditional] ADD CONSTRAINT [MergeAdditional_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MergeAdditional] ADD CONSTRAINT [MergeAdditional_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CardStock] ADD CONSTRAINT [CardStock_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CardMovement] ADD CONSTRAINT [CardMovement_cardID_fkey] FOREIGN KEY ([cardID]) REFERENCES [dbo].[Card]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CardMovement] ADD CONSTRAINT [CardMovement_sourceCode_fkey] FOREIGN KEY ([sourceCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CardMovement] ADD CONSTRAINT [CardMovement_targetCode_fkey] FOREIGN KEY ([targetCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CardMovement] ADD CONSTRAINT [CardMovement_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[NumberMovement] ADD CONSTRAINT [NumberMovement_numberID_fkey] FOREIGN KEY ([numberID]) REFERENCES [dbo].[Number]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[NumberMovement] ADD CONSTRAINT [NumberMovement_sourceCode_fkey] FOREIGN KEY ([sourceCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[NumberMovement] ADD CONSTRAINT [NumberMovement_targetCode_fkey] FOREIGN KEY ([targetCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[NumberMovement] ADD CONSTRAINT [NumberMovement_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Distribution] ADD CONSTRAINT [Distribution_sourceCode_fkey] FOREIGN KEY ([sourceCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Distribution] ADD CONSTRAINT [Distribution_targetCode_fkey] FOREIGN KEY ([targetCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Distribution] ADD CONSTRAINT [Distribution_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DistributionSubmittance] ADD CONSTRAINT [DistributionSubmittance_distributionID_fkey] FOREIGN KEY ([distributionID]) REFERENCES [dbo].[Distribution]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DistributionSubmittance] ADD CONSTRAINT [DistributionSubmittance_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DistributionItem] ADD CONSTRAINT [DistributionItem_itemKey_fkey] FOREIGN KEY ([itemKey]) REFERENCES [dbo].[Card]([key]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DistributionItem] ADD CONSTRAINT [DistributionItem_distributionID_fkey] FOREIGN KEY ([distributionID]) REFERENCES [dbo].[Distribution]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Opname] ADD CONSTRAINT [Opname_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Opname] ADD CONSTRAINT [Opname_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OpnameSubmittance] ADD CONSTRAINT [OpnameSubmittance_opnameID_fkey] FOREIGN KEY ([opnameID]) REFERENCES [dbo].[Opname]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OpnameSubmittance] ADD CONSTRAINT [OpnameSubmittance_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OpnameSubmittanceDocumentation] ADD CONSTRAINT [OpnameSubmittanceDocumentation_submittanceID_fkey] FOREIGN KEY ([submittanceID]) REFERENCES [dbo].[OpnameSubmittance]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OpnameUpdate] ADD CONSTRAINT [OpnameUpdate_opnameID_fkey] FOREIGN KEY ([opnameID]) REFERENCES [dbo].[Opname]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OpnameUpdate] ADD CONSTRAINT [OpnameUpdate_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_circleCode_fkey] FOREIGN KEY ([circleCode]) REFERENCES [dbo].[Circle]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Permission] ADD CONSTRAINT [Permission_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Permission] ADD CONSTRAINT [Permission_accessCode_fkey] FOREIGN KEY ([accessCode]) REFERENCES [dbo].[Access]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Session] ADD CONSTRAINT [Session_userCode_fkey] FOREIGN KEY ([userCode]) REFERENCES [dbo].[User]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CheckpointCircle] ADD CONSTRAINT [CheckpointCircle_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CheckpointCircle] ADD CONSTRAINT [CheckpointCircle_circleCode_fkey] FOREIGN KEY ([circleCode]) REFERENCES [dbo].[Circle]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

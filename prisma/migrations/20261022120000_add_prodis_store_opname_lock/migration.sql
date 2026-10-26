BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[OpnameUpdate] ADD [source] NVARCHAR(1000);

-- CreateTable
CREATE TABLE [dbo].[StoreOpnameLock] (
    [id] INT NOT NULL IDENTITY(1,1),
    [checkpointCode] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [StoreOpnameLock_status_df] DEFAULT 'IDLE',
    [lockedByCode] NVARCHAR(1000),
    [lockedAt] DATETIME2,
    [expiresAt] DATETIME2,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [StoreOpnameLock_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [StoreOpnameLock_checkpointCode_key] UNIQUE NONCLUSTERED ([checkpointCode])
);

-- AddForeignKey
ALTER TABLE [dbo].[StoreOpnameLock] ADD CONSTRAINT [StoreOpnameLock_checkpointCode_fkey] FOREIGN KEY ([checkpointCode]) REFERENCES [dbo].[Checkpoint]([code]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

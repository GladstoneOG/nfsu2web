-- Store encrypted vault saves (<= 256 KiB each) directly in D1 so no R2 bucket is required.
ALTER TABLE vault_saves ADD COLUMN blob BLOB;
ALTER TABLE vault_saves ADD COLUMN earlier_blob BLOB;

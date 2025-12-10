DROP TABLE IF EXISTS inventory;
CREATE TABLE inventory (
    id UUID PRIMARY KEY, 
     name VARCHAR(255) NOT NULL, 
     description TEXT, 
    photo_path VARCHAR(255), 
   photo_url VARCHAR(255), 
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


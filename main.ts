import Flatter from "./Flatter.ts";

class Address extends Flatter {
    street : string = "";    
    city   : string  = "";

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
            city TEXT,
        )
    `;
}

class User extends Flatter {
    username : string = "";
    created  : Date = new Date();

    shippingAddress : Address = new Address();
    
    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            username TEXT NOT NULL,
            created DATETIME,
            shippingAddress UUID,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES addresses(uuid)
        );
    `;

    static {
        this.init();
    }
}

import { Database } from "jsr:@db/sqlite@0.11";
const db = new Database("test.sqlite")
db.run('PRAGMA journal_mode = WAL;')        
db.run('PRAGMA FOREIGN_KEY = ON;')        

const u = new User({ username: 'james'});
u.save();
const y = User.load( u.uuid );

console.log("Created:",u);
console.log("Loaded:",y)
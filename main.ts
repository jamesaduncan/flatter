import Flatter from "./Flatter.ts";

class Address extends Flatter {
    street : string = "";    
    city   : string  = "";
    postcode : string = "";

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
            postcode TEXT,
            city TEXT
        )
    `;

    static {
        this.init();
    }
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
            shippingAddress Address,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES Addresses(uuid)
        );
    `;

    static {
        this.init();
    }
}

const u = new User({ username: 'james'});
u.save();

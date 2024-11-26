import Flatter from "./Flatter.ts"

class Address extends Flatter {
    street   = "";    
    city     = "";
    postcode = "";

    constructor( template ) {
        super();
        if (template) {
            Object.assign(this, template)
        }
    }

    static SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
            postcode TEXT,
            city TEXT,
            flatter OBJECT
        )
    `;

    static {
        this.init();
    }
}

class User extends Flatter {
    username = "";
    created  = new Date();
    shippingAddress = new Address();

    constructor( template ) {
        super();
        if (template) {
            Object.assign( this, template );
        }
    }

    static SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            username TEXT UNIQUE NOT NULL,
            created DATETIME,
            shippingAddress Address,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES Addresses(uuid) ON DELETE CASCADE
        );
    `;

    static {
        this.init();
    }
}

const bill = new User({ 
    username: 'bill', 
    shippingAddress: new Address({ street: '17 West Street', city: 'Wareham'} )
});
bill.save();
console.log(bill);
console.log( User.loadWithUUID( bill.uuid ) );
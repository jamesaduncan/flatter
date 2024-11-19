import Flatter from "./Flatter.ts";

class Address extends Flatter {
    street : string = "";    
    city   : string  = "";

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
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
            shippingAddress UUID,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES addresses(uuid)
        );
    `;

    static {
        this.init();
    }
}

console.log("User", User.tableInfo);
console.log("Address", Address.tableInfo)

const u = new User({ username: 'james'});
u.save();
const y = User.load( u.uuid );

console.log("Created:",u);
console.log("Loaded:",y)
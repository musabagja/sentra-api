import bcrypt from 'bcrypt'

class Bcrypt {
  static hash = (string: string) => {
    return bcrypt.hashSync(string, process.env.BCRYPT_SALT_ROUND as string)
  }

  static compare = (string: string, hash: string) => {
    return bcrypt.compareSync(string, hash)
  }
}

export default Bcrypt